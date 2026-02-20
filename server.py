import http.server
import socketserver
import mimetypes
import json
import os
import urllib.parse
import asyncio

from app.config import get_settings
from app.core.rag_chain import get_rag_chain

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/x-icon", ".ico")

PORT = int(os.getenv("PORT", "5173"))
settings = get_settings()

def _read_json(handler: http.server.BaseHTTPRequestHandler):
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length > 0 else b"{}"
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        return {}

def _send_json(handler: http.server.BaseHTTPRequestHandler, obj, status=200):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(data)

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/chat":
            payload = _read_json(self)
            message = (payload.get("message") or "").strip()
            history = payload.get("history") or []
            discount = int(payload.get("discount") or 0)

            if not message:
                return _send_json(self, {"error": "message is required"}, status=400)

            try:
                chain = get_rag_chain()
                result = asyncio.run(chain.generate(question=message, discount=discount, history=history))
                return _send_json(self, result, status=200)
            except Exception as e:
                return _send_json(self, {"error": str(e)}, status=500)

        return _send_json(self, {"error": "not found"}, status=404)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            try:
                chain = get_rag_chain()
                ok = asyncio.run(chain.llm.check_health())
                return _send_json(self, {
                    "ok": bool(ok),
                    "host": settings.ollama_host,
                    "model": settings.ollama_model
                }, status=200)
            except Exception as e:
                return _send_json(self, {
                    "ok": False,
                    "host": settings.ollama_host,
                    "model": settings.ollama_model,
                    "error": str(e)
                }, status=200)

        return super().do_GET()

if __name__ == "__main__":
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Serving on http://127.0.0.1:{PORT}")
        print(f"Ollama: {settings.ollama_host} | Model: {settings.ollama_model}")
        httpd.serve_forever()
