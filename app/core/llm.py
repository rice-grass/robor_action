import json
import asyncio
import urllib.request
from typing import AsyncIterator, Optional

from app.config import get_settings

settings = get_settings()


class OllamaLLM:
    def __init__(
        self,
        model: Optional[str] = None,
        temperature: float = 0.3,
        num_ctx: int = 4096
    ):
        self.model = model or settings.ollama_model
        self.base_url = settings.ollama_host
        self.temperature = temperature
        self.num_ctx = num_ctx

    def _generate_sync(self, prompt: str, fmt: str = "") -> str:
        url = f"{self.base_url}/api/generate"
        payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": self.temperature,
                "num_ctx": self.num_ctx
            }
        }
        if fmt:
            payload["format"] = fmt
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            obj = json.loads(resp.read().decode("utf-8"))
            return obj.get("response", "")

    async def generate(self, prompt: str, fmt: str = "") -> str:
        return await asyncio.to_thread(self._generate_sync, prompt, fmt)

    async def generate_stream(self, prompt: str) -> AsyncIterator[str]:
        # Minimal streaming fallback (kept for compatibility)
        yield await self.generate(prompt, fmt="")

    async def check_health(self) -> bool:
        try:
            url = f"{self.base_url}/api/tags"
            with urllib.request.urlopen(url, timeout=5) as resp:
                return resp.status == 200
        except Exception:
            return False

    async def list_models(self) -> list:
        try:
            url = f"{self.base_url}/api/tags"
            with urllib.request.urlopen(url, timeout=8) as resp:
                if resp.status != 200:
                    return []
                obj = json.loads(resp.read().decode("utf-8"))
                return [m.get("name") for m in obj.get("models", []) if m.get("name")]
        except Exception:
            return []


_llm_instance: Optional[OllamaLLM] = None

def get_llm() -> OllamaLLM:
    global _llm_instance
    if _llm_instance is None:
        _llm_instance = OllamaLLM()
    return _llm_instance
