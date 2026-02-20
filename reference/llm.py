from langchain_community.llms import Ollama
from langchain_community.chat_models import ChatOllama
from typing import AsyncIterator, Optional
import httpx

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

        # LangChain Ollama 인스턴스
        self.llm = Ollama(
            model=self.model,
            base_url=self.base_url,
            temperature=self.temperature,
            num_ctx=self.num_ctx,
        )

        self.chat_llm = ChatOllama(
            model=self.model,
            base_url=self.base_url,
            temperature=self.temperature,
            num_ctx=self.num_ctx,
        )

    async def generate(self, prompt: str) -> str:
        """일반 텍스트 생성"""
        return await self.llm.ainvoke(prompt)

    async def generate_stream(self, prompt: str) -> AsyncIterator[str]:
        """스트리밍 텍스트 생성"""
        async for chunk in self.llm.astream(prompt):
            yield chunk

    async def check_health(self) -> bool:
        """Ollama 서버 상태 확인"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.base_url}/api/tags",
                    timeout=5.0
                )
                return response.status_code == 200
        except Exception:
            return False

    async def list_models(self) -> list:
        """사용 가능한 모델 목록"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.base_url}/api/tags",
                    timeout=5.0
                )
                if response.status_code == 200:
                    data = response.json()
                    return [model["name"] for model in data.get("models", [])]
                return []
        except Exception:
            return []


# 싱글톤 인스턴스
_llm_instance: Optional[OllamaLLM] = None


def get_llm() -> OllamaLLM:
    global _llm_instance
    if _llm_instance is None:
        _llm_instance = OllamaLLM()
    return _llm_instance
