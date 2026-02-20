import re
import json
from typing import List, Dict, Any, Optional

from app.core.llm import get_llm

# 프론트엔드 MOTIONS 라이브러리와 동기화된 유효 모션 목록
VALID_MOTIONS = {
    "neutral", "wave", "greet", "think", "point",
    "nod", "shake", "shrug", "cheer", "dance",
    "stretch", "bow", "clap", "excited", "sad",
}

# 특정 각도 지정 시 사용하는 group 이름과 범위
ROBOT_GROUPS = {
    "rightArm": (-90, 90),
    "leftArm":  (-90, 90),
    "head":     (-60, 60),
}

SYSTEM_PROMPT = """/no_think
당신은 3D 로봇 대시보드의 AI 컨트롤러입니다.
사용자의 한국어 명령을 해석하여 로봇을 제어하고 자연스럽게 대화합니다.

## 사용 가능한 동작 (motion 필드에 이름으로 지정)
- neutral : 기본 자세로 돌아가기
- wave    : 오른팔 들어 흔들기
- greet   : 인사 (손 흔들고 고개 숙임)
- think   : 생각하기 (머리 기울이고 팔 올림)
- point   : 오른팔로 가리키기
- nod     : 고개 끄덕이기 (긍정/동의)
- shake   : 고개 젓기 (부정/모름)
- shrug   : 어깨 으쓱 (모르겠다는 몸짓)
- cheer   : 환호/만세 (양팔 위로)
- dance   : 춤추기 (양팔 교차 흔들기)
- stretch : 스트레칭 (양팔 크게 펼치기)
- bow     : 절하기 (고개 숙임)
- clap    : 박수 치기
- excited : 신남/흥분 표현
- sad     : 슬픔/실망 표현

## 응답 형식 (반드시 JSON만 출력, 다른 텍스트 없이)
동작 있을 때:  {{"content": "한국어 응답", "motion": "wave"}}
동작 없을 때:  {{"content": "한국어 응답", "motion": null}}
특정 각도 요청: {{"content": "응답", "motion": null, "actions": [{{"group": "rightArm", "angle": 45, "axis": "z"}}]}}

## 대화 기록
{history}

## 사용자 입력
{question}"""


class RAGChain:
    def __init__(self):
        self.llm = get_llm()

    def _format_history(self, history: List[Dict[str, str]]) -> str:
        if not history:
            return "없음"
        formatted = []
        for msg in history[-5:]:
            role = "사용자" if msg["role"] == "user" else "로봇"
            formatted.append(f"{role}: {msg['content']}")
        return "\n".join(formatted)

    def _extract_json(self, raw: str) -> Dict[str, Any]:
        """LLM 응답에서 JSON 추출. <think> 태그, 마크다운 코드블록 등 제거."""
        # 1. <think>...</think> 제거 (qwen3 thinking mode)
        text = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
        # 2. 마크다운 코드블록 제거
        text = re.sub(r"```(?:json)?\s*([\s\S]*?)\s*```", r"\1", text).strip()
        # 3. 직접 파싱
        try:
            return json.loads(text)
        except (json.JSONDecodeError, ValueError):
            pass
        # 4. 첫 { ... } 추출
        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            try:
                return json.loads(match.group())
            except (json.JSONDecodeError, ValueError):
                pass
        # 5. 파싱 실패 시 텍스트만 반환
        return {"content": text or "응답을 처리할 수 없습니다.", "motion": None}

    def _validate_actions(self, actions: Any) -> List[Dict]:
        """특정 각도 지정 시 사용하는 actions 검증 및 클램핑."""
        if not isinstance(actions, list):
            return []
        validated = []
        for a in actions:
            if not isinstance(a, dict):
                continue
            group = a.get("group")
            if group not in ROBOT_GROUPS:
                continue
            try:
                angle = float(a.get("angle", 0))
            except (TypeError, ValueError):
                continue
            lo, hi = ROBOT_GROUPS[group]
            angle = max(lo, min(hi, round(angle)))
            validated.append({"group": group, "angle": angle, "axis": "z"})
        return validated

    async def generate(
        self,
        question: str,
        discount: int = 0,
        history: List[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        prompt = SYSTEM_PROMPT.format(
            history=self._format_history(history or []),
            question=question
        )

        raw = await self.llm.generate(prompt)
        parsed = self._extract_json(raw or "")

        content = str(parsed.get("content", "")).strip() or "(빈 응답)"

        # motion 우선 — 유효하지 않으면 None
        motion = parsed.get("motion")
        if motion not in VALID_MOTIONS:
            motion = None

        # motion 없을 때만 actions 사용 (특정 각도 지정 명령용)
        actions = [] if motion else self._validate_actions(parsed.get("actions", []))

        return {
            "content": content,
            "sources": [],
            "type": "text",
            "motion": motion,
            "actions": actions,
        }


_rag_chain_instance: Optional[RAGChain] = None

def get_rag_chain() -> RAGChain:
    global _rag_chain_instance
    if _rag_chain_instance is None:
        _rag_chain_instance = RAGChain()
    return _rag_chain_instance
