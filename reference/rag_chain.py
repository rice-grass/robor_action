from langchain_core.prompts import PromptTemplate
from typing import AsyncIterator, List, Dict, Any, Optional
from datetime import datetime

from app.core.llm import get_llm
from app.db.vector_store import get_vectorstore
from app.config import get_settings
from app.models.schemas import Source

settings = get_settings()

# 시스템 프롬프트 (한국어)
SYSTEM_PROMPT = """당신은 "Jungle Zero" 레이저 제모 전문 매장의 AI 상담사입니다.

## 역할
1. 예약 안내 및 일정 확인
2. 서비스 가격 및 패키지 안내
3. 게임 플레이 가이드 제공
4. 친절하고 전문적인 고객 응대

## 컨텍스트
- 고객이 획득한 할인 쿠폰: {discount}%
- 현재 날짜: {current_date}

## 참고 문서
{context}

## 대화 기록
{history}

## 지침
- 항상 한국어로 응답하세요
- 정보가 문서에 없으면 그에 맞는 대답을 생각해서 알려주세요
- 예약 관련 질문에는 구체적인 시간대를 안내하세요
- 가격 정보는 정확하게 안내하고, 할인 쿠폰 적용 가격도 함께 알려주세요
- 응답은 간결하고 명확하게 작성하세요

## 질문
{question}

## 응답"""


class RAGChain:
    def __init__(self):
        self.llm = get_llm()
        self.vectorstore = get_vectorstore()
        self.retriever = self.vectorstore.get_retriever()

        self.prompt = PromptTemplate(
            template=SYSTEM_PROMPT,
            input_variables=["discount", "current_date", "context", "history", "question"]
        )

    def _format_history(self, history: List[Dict[str, str]]) -> str:
        """대화 기록 포맷팅"""
        if not history:
            return "없음"

        formatted = []
        for msg in history[-5:]:  # 최근 5개 메시지만
            role = "사용자" if msg["role"] == "user" else "상담사"
            formatted.append(f"{role}: {msg['content']}")

        return "\n".join(formatted)

    def _format_context(self, docs: List) -> str:
        """검색된 문서 컨텍스트 포맷팅"""
        if not docs:
            return "관련 문서가 없습니다."

        context_parts = []
        for i, doc in enumerate(docs, 1):
            source = doc.metadata.get("source", "unknown")
            context_parts.append(f"[문서 {i} - {source}]\n{doc.page_content}")

        return "\n\n".join(context_parts)

    async def generate(
        self,
        question: str,
        discount: int = 0,
        history: List[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """RAG 기반 응답 생성"""
        # 문서 검색
        docs = self.retriever.invoke(question)

        # 프롬프트 구성
        prompt = self.prompt.format(
            discount=discount,
            current_date=datetime.now().strftime("%Y-%m-%d"),
            context=self._format_context(docs),
            history=self._format_history(history or []),
            question=question
        )

        # LLM 호출
        response = await self.llm.generate(prompt)

        # 소스 정보 추출
        sources = [
            Source(
                content=doc.page_content[:200] + "..." if len(doc.page_content) > 200 else doc.page_content,
                metadata=doc.metadata
            )
            for doc in docs
        ]

        return {
            "content": response.strip(),
            "sources": sources,
            "type": self._detect_response_type(question)
        }

    async def generate_stream(
        self,
        question: str,
        discount: int = 0,
        history: List[Dict[str, str]] = None
    ) -> AsyncIterator[Dict[str, Any]]:
        """RAG 기반 스트리밍 응답 생성"""
        # 문서 검색
        docs = self.retriever.invoke(question)

        # 프롬프트 구성
        prompt = self.prompt.format(
            discount=discount,
            current_date=datetime.now().strftime("%Y-%m-%d"),
            context=self._format_context(docs),
            history=self._format_history(history or []),
            question=question
        )

        # 소스 정보
        sources = [
            Source(
                content=doc.page_content[:200] + "..." if len(doc.page_content) > 200 else doc.page_content,
                metadata=doc.metadata
            )
            for doc in docs
        ]

        # 스트리밍 응답
        async for chunk in self.llm.generate_stream(prompt):
            yield {
                "content": chunk,
                "done": False,
                "sources": []
            }

        # 마지막 청크에 소스 포함
        yield {
            "content": "",
            "done": True,
            "sources": sources
        }

    def _detect_response_type(self, question: str) -> str:
        """질문 유형 감지"""
        question_lower = question.lower()

        if any(kw in question_lower for kw in ["예약", "신청", "예매", "부킹"]):
            return "booking"
        elif any(kw in question_lower for kw in ["일정", "스케줄", "시간", "언제"]):
            return "schedule"
        elif any(kw in question_lower for kw in ["가격", "비용", "요금", "얼마"]):
            return "price"
        elif any(kw in question_lower for kw in ["게임", "미로", "조작", "플레이", "쿠폰"]):
            return "game_guide"
        else:
            return "text"


# 싱글톤 인스턴스
_rag_chain_instance: Optional[RAGChain] = None


def get_rag_chain() -> RAGChain:
    global _rag_chain_instance
    if _rag_chain_instance is None:
        _rag_chain_instance = RAGChain()
    return _rag_chain_instance
