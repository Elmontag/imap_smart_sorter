from imapclient import IMAPClient
from settings import S
from datetime import datetime, timedelta

def _connect():
    server = IMAPClient(S.IMAP_HOST, port=S.IMAP_PORT, ssl=S.IMAP_USE_SSL)
    server.login(S.IMAP_USERNAME, S.IMAP_PASSWORD)
    return server

def list_folders():
    try:
        with _connect() as server:
            res = server.list_folders()
            return [r[2] for r in res]
    except Exception:
        return []

def folder_exists(name: str) -> bool:
    return name in list_folders()

def _since_date():
    days = int(S.SINCE_DAYS) if hasattr(S, "SINCE_DAYS") else 30
    dt = datetime.utcnow() - timedelta(days=days)
    return dt.date()  # IMAP expects date, not datetime

def search_seen_recent(server: IMAPClient, folder: str):
    server.select_folder(folder, readonly=True)
    criteria = ["SEEN"]
    sd = _since_date()
    criteria += ["SINCE", sd]
    # exclude deleted
    uids = server.search(criteria)
    return uids

def fetch_messages(server: IMAPClient, uids, batch_size=100):
    if not uids: 
        return {}
    out = {}
    for i in range(0, len(uids), batch_size):
        chunk = uids[i:i+batch_size]
        data = server.fetch(chunk, [b"RFC822", b"FLAGS"])
        out.update(data)
    return out

def move_message(uid: str, target_folder: str, src_folder: str|None=None):
    with _connect() as server:
        if not src_folder:
            src_folder = S.IMAP_INBOX
        server.select_folder(src_folder)
        i_uid = int(uid) if not isinstance(uid, int) else uid
        try:
            server.move([i_uid], target_folder)
        except Exception:
            server.copy([i_uid], target_folder)
            server.delete_messages([i_uid])
            server.expunge()
