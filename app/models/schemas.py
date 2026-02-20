from dataclasses import dataclass
from typing import Any, Dict

@dataclass
class Source:
    content: str
    metadata: Dict[str, Any]
