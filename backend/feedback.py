
"""Feedback helpers to evolve folder profiles from user decisions."""

from __future__ import annotations

from typing import Sequence

from database import upsert_folder_profile


def update_profiles_on_accept(folder: str, embedding: Sequence[float] | None) -> None:
    if embedding:
        upsert_folder_profile(folder, list(embedding))
