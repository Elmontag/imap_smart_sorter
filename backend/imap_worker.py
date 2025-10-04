
import asyncio, email
from email import policy
from settings import S
from database import save_suggestion, list_folder_profiles, mark_moved, mark_failed
from classifier import rank_with_profiles, embed, propose_new_folder_if_needed
from mailbox import move_message
from utils import extract_text, subject_from, thread_headers
from models import Suggestion

async def process_loop():
    while True:
        await asyncio.sleep(S.POLL_INTERVAL_SECONDS)

async def handle_message(uid: str, raw_bytes: bytes, src_folder: str):
    msg = email.message_from_bytes(raw_bytes, policy=policy.default)
    text = extract_text(msg)
    subj, from_addr = subject_from(msg)
    th = thread_headers(msg)
    profiles = [{"name": fp.name, "centroid": fp.centroid} for fp in list_folder_profiles()]
    ranked = await rank_with_profiles(text, profiles) if profiles else []
    top_score = ranked[0][1] if ranked else 0.0
    proposal = await propose_new_folder_if_needed(top_score)
    sug = Suggestion(
        message_uid=str(uid),
        src_folder=src_folder,
        subject=subj,
        from_addr=from_addr,
        date=str(msg.get("Date")),
        thread_id=th.get("message_id"),
        ranked=[{"name": n, "score": s} for n,s in ranked],
        proposal=proposal,
        status="open",
        move_status="pending"
    )
    save_suggestion(sug)
    if S.MOVE_MODE == "AUTO" and (top_score >= S.AUTO_THRESHOLD or th.get("in_reply_to")):
        try:
            target = ranked[0][0] if ranked else None
            if target:
                move_message(uid, target, src_folder=src_folder)
                mark_moved(str(uid))
        except Exception as e:
            mark_failed(str(uid), str(e))

if __name__ == "__main__":
    try:
        asyncio.run(process_loop())
    except KeyboardInterrupt:
        pass
