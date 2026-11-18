import base64
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mapp


class PhotoPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [patch.object(mapp, key, str(self.root / value)) for key, value in (
            ("COMPOSE_PHOTO_DIR", "anh-le-2"), ("STAGING_DIR", "cho-cdn"),
            ("PRINT_DIR", "in"), ("PRINTING_DIR", "dang-in"), ("PRINTED_DIR", "da-in"),
        )]
        self.patches.append(patch.object(mapp, "booth_device_id", return_value="TEST_DEVICE"))
        for item in self.patches:
            item.start()
        stream = BytesIO()
        Image.new("RGB", (48, 32), (170, 90, 20)).save(stream, "PNG")
        self.png = stream.getvalue()
        self.photo = "data:image/png;base64," + base64.b64encode(self.png).decode()
        self.server = mapp.ThreadingHTTPServer(("127.0.0.1", 0), mapp.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def post(self, route, payload):
        request = urllib.request.Request(self.base + route,
            data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def test_cloud_cache_retains_shared_background_payment_timeout(self):
        with patch.object(mapp, "CLOUD_CONFIG_FILE", str(self.root / "cloud-config.json")):
            ok, error = mapp.save_cloud_config_cache({
                "previewReplaceTimeoutSeconds": 180, "paymentTimeoutSeconds": 60,
            })
            self.assertTrue(ok, error)
            cached = mapp.load_cloud_config_cache()["config"]
            self.assertEqual(cached["previewReplaceTimeoutSeconds"], 180)
            self.assertEqual(cached["paymentTimeoutSeconds"], 60)

    def test_all_extra_photos_are_preserved_and_print_manifest_updated(self):
        for count in (4, 6):
            with self.subTest(count=count):
                order = "TEST_" + str(count)
                result = self.post("/api/v1/capture-photos", {
                    "orderId": order, "photos": [self.photo] * count,
                })
                self.assertEqual(len(result["photos"]), count)
                self.assertEqual(len(result["composePhotos"]), count)
                compose_folder = self.root / "anh-le-2" / order
                for i in range(1, count + 1):
                    self.assertEqual((compose_folder / (str(i) + ".png")).read_bytes(), self.png)
                    self.assertTrue(result["composePhotos"][i - 1].startswith("/public/anh-le-2/"))
                self.assertEqual(result["photos"], result["composePhotos"])
                self.assertFalse((self.root / "anh-le").exists())
                folder = compose_folder
                captured_manifest = json.loads((folder / "job.json").read_text())
                self.assertEqual(captured_manifest["deviceId"], "TEST_DEVICE")
                # A job created before deviceId was added is repaired at print time.
                del captured_manifest["deviceId"]
                (folder / "job.json").write_text(json.dumps(captured_manifest))
                for i in range(1, count + 1):
                    self.assertEqual((folder / (str(i) + ".png")).read_bytes(), self.png)
                layout = [count - 1, 0]
                job = self.post("/api/v1/prints", {
                    "orderId": order, "image": self.photo, "pageW": 1200,
                    "pageH": 1800, "qty": 1, "paperSize": "4x6", "dpi": 600,
                    "paperWidthInch": 4, "paperHeightInch": 6, "layout": layout,
                })
                self.assertTrue(job["ok"])
                self.assertEqual((self.root / "cho-cdn" / job["id"] / "print.png").read_bytes(), self.png)
                manifest = json.loads((folder / "job.json").read_text())
                self.assertEqual(manifest["deviceId"], "TEST_DEVICE")
                self.assertEqual(manifest["print"]["deviceId"], "TEST_DEVICE")
                self.assertEqual(manifest["photoCount"], count)
                self.assertEqual(manifest["photos"], [str(i) + ".png" for i in range(1, count + 1)])
                self.assertEqual(manifest["layout"], layout)
                self.assertEqual(manifest["printJobId"], job["id"])
                self.assertEqual(manifest["print"]["dpi"], 600)
                self.assertEqual(manifest["print"]["image"], "print.png")
                self.assertFalse((self.root / "anh-le").exists())

    def test_invalid_composition_manifest_does_not_block_print_job(self):
        for content in ('{unfinished', '[]'):
            folder = self.root / 'anh-le-2' / 'PROCESSING'
            folder.mkdir(parents=True, exist_ok=True)
            (folder / 'job.json').write_text(content)
            job = self.post('/api/v1/prints', {
                'orderId': 'PROCESSING', 'image': self.photo,
                'pageW': 1200, 'pageH': 1800, 'qty': 1,
            })
            self.assertTrue(job['ok'])
            self.assertEqual((self.root / 'cho-cdn' / job['id'] / 'print.png').read_bytes(), self.png)

    def test_print_job_publishes_qr_placement_without_changing_png(self):
        job = self.post("/api/v1/prints", {
            "orderId": "EXE_QR", "image": self.photo, "pageW": 1200, "pageH": 1800,
            "qty": 1, "paperSize": "4x6", "dpi": 600,
            "frameRel": "tmp2/frame_6.png", "qrRect": {"x": 552, "y": 1551, "w": 200, "h": 200},
            "dateRect": {"x": 549, "y": 1720, "w": 200, "h": 36}, "dateText": "17:22 10/11/2026",
        })
        folder = self.root / "cho-cdn" / job["id"]
        self.assertEqual((folder / "print.png").read_bytes(), self.png)
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["job.json", "print.png", "qr-place.json"])
        manifest = json.loads((folder / "job.json").read_text())
        self.assertEqual(manifest["image"], "print.png")
        self.assertEqual(manifest["orderId"], "EXE_QR")
        placement = json.loads((folder / "qr-place.json").read_text())
        self.assertEqual(placement, {
            "frameRel": "tmp2/frame_6.png",
            "qr": {"x": 552, "y": 1551, "w": 200, "h": 200},
            "date": {"x": 549, "y": 1720, "w": 200, "h": 36}, "dateText": "17:22 10/11/2026",
        })
        self.assertNotIn("qrRect", manifest)

    def test_status_finds_job_moved_forward_during_lookup(self):
        job = self.post("/api/v1/prints", {
            "orderId": "MOVING", "image": self.photo,
            "pageW": 1200, "pageH": 1800, "qty": 1,
        })
        source = self.root / "cho-cdn" / job["id"]
        destination = self.root / "in" / job["id"]
        real_isdir = mapp.os.path.isdir
        moved = False

        def isdir_while_moving(path):
            nonlocal moved
            if str(path) == str(source) and not moved:
                source.rename(destination)
                moved = True
            return real_isdir(path)

        with patch.object(mapp.os.path, "isdir", side_effect=isdir_while_moving):
            status = mapp.print_job_status(job["id"])
        self.assertTrue(moved)
        self.assertEqual(status["status"], "queued")
        self.assertTrue(status["ok"])

    def test_invalid_qr_placement_does_not_publish_bad_coordinates(self):
        for rect in ({"x": -1, "y": 0, "w": 20, "h": 20},
                     {"x": 1190, "y": 0, "w": 20, "h": 20},
                     {"x": 0, "y": 0, "w": 0, "h": 20},
                     {"x": "NaN", "y": 0, "w": 20, "h": 20}, {"w": 20}):
            with self.subTest(rect=rect):
                job = self.post("/api/v1/prints", {
                    "orderId": "BAD_QR", "image": self.photo, "pageW": 1200,
                    "pageH": 1800, "qty": 1, "qrRect": rect,
                })
                folder = self.root / "cho-cdn" / job["id"]
                self.assertFalse((folder / "qr-place.json").exists())
                self.assertNotIn("qrRect", json.loads((folder / "job.json").read_text()))

    def test_replacing_photo_changes_url_and_serves_new_bytes(self):
        first = self.post("/api/v1/capture-photos", {"orderId": "RETRY", "photos": [self.photo]})
        stream = BytesIO()
        Image.new("RGB", (48, 32), (20, 90, 170)).save(stream, "PNG")
        new_bytes = stream.getvalue()
        second = self.post("/api/v1/capture-photos", {"orderId": "RETRY", "photos": [
            "data:image/png;base64," + base64.b64encode(new_bytes).decode()]})
        self.assertNotEqual(first["photos"][0], second["photos"][0])
        self.assertEqual((self.root / "anh-le-2" / "RETRY" / "1.png").read_bytes(), new_bytes)
        self.assertEqual(list((self.root / "anh-le-2" / "RETRY").glob("*.png")),
                         [self.root / "anh-le-2" / "RETRY" / "1.png"])
        self.assertFalse((self.root / "anh-le").exists())

    def test_personal_photos_and_print_previews_are_not_cached(self):
        with patch.object(mapp, "ROOT", str(self.root)):
            for relative in ("public/anh-le/ORDER/1.png", "public/anh-le-2/ORDER/1.png", "public/cho-cdn/JOB/print.png"):
                file = self.root / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(self.png)
                with urllib.request.urlopen(self.base + "/" + relative + "?v=updated", timeout=5) as response:
                    self.assertEqual(response.headers["Cache-Control"], "no-store")
                    self.assertEqual(response.headers["Content-Type"], "image/png")
                    self.assertEqual(response.read(), self.png)

    def test_jpeg_is_rejected_for_capture_and_print(self):
        stream = BytesIO()
        Image.new("RGB", (48, 32)).save(stream, "JPEG")
        photo = "data:image/jpeg;base64," + base64.b64encode(stream.getvalue()).decode()
        for route, payload in (
            ("/api/v1/capture-photos", {"orderId": "TEST", "photos": [photo]}),
            ("/api/v1/prints", {"orderId": "TEST", "image": photo, "pageW": 1200, "pageH": 1800, "qty": 1}),
            ("/api/v1/capture-photos", {"orderId": "TEST", "photos": [photo.replace("image/jpeg", "image/png")]}),
        ):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.post(route, payload)
            self.assertEqual(error.exception.code, 400)

    def test_done_marker_requires_all_print_copies(self):
        folder = self.root / "dang-in" / "JOB"
        folder.mkdir(parents=True)
        (folder / "job.json").write_text(json.dumps({"orderId": "ORDER", "qty": 2}))
        (folder / "printed.txt").write_text("1")
        marker = self.root / "anh-le-2" / "ORDER" / "done.txt"
        self.assertEqual(mapp.print_job_status("JOB")["status"], "printing")
        self.assertFalse(marker.exists())
        (folder / "printed.txt").write_text("2")
        self.assertEqual(mapp.print_job_status("JOB")["status"], "done")
        self.assertEqual(marker.read_bytes(), b"done")
        self.assertFalse((self.root / "anh-le").exists())
        with patch.object(mapp.os, "replace") as replace:
            mapp.print_job_status("JOB")
            replace.assert_not_called()

    def test_background_scan_marks_completed_jobs_without_browser(self):
        folder = self.root / "da-in" / "FINISHED"
        folder.mkdir(parents=True)
        (folder / "job.json").write_text(json.dumps({"orderId": "OFFLINE", "qty": 1}))
        mapp.sync_print_completions()
        marker = self.root / "anh-le-2" / "OFFLINE" / "done.txt"
        self.assertEqual(marker.read_bytes(), b"done")
        self.assertFalse((self.root / "anh-le").exists())

    def test_uploading_and_failed_jobs_do_not_get_done_marker(self):
        for stage, skipped in (("cho-cdn", False), ("dang-in", True), ("da-in", True)):
            with self.subTest(stage=stage, skipped=skipped):
                folder = self.root / stage / ("JOB_" + stage)
                folder.mkdir(parents=True)
                order = "ORDER_" + stage
                (folder / "job.json").write_text(json.dumps({"orderId": order, "qty": 1}))
                if skipped:
                    (folder / "skip.txt").write_text("cancelled")
                mapp.sync_print_completions()
                self.assertFalse((self.root / "anh-le-2" / order / "done.txt").exists())
        invalid = self.root / "da-in" / "INVALID"
        invalid.mkdir(parents=True)
        (invalid / "job.json").write_text(json.dumps({"orderId": "../escape", "qty": 1}))
        mapp.sync_print_completions()
        self.assertFalse((self.root / "escape").exists())

    def test_bad_paths_and_bad_photos_do_not_write_partial_jobs(self):
        for order, photos in (("../escape", [self.photo]), ("TEST", []),
                              ("TEST", [self.photo, "broken"]), ("TEST", [self.photo] * 33)):
            with self.subTest(order=order, count=len(photos)):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    self.post("/api/v1/capture-photos", {"orderId": order, "photos": photos})
                self.assertEqual(error.exception.code, 400)
        self.assertFalse((self.root / "anh-le").exists())
        self.assertFalse((self.root / "anh-le-2").exists())


if __name__ == "__main__":
    unittest.main()
