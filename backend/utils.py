
from email.header import decode_header

def extract_text(msg) -> str:
    if msg.is_multipart():
        parts = []
        for part in msg.walk():
            ctype = part.get_content_type()
            if ctype == "text/plain":
                try:
                    parts.append(part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="ignore"))
                except Exception:
                    pass
        return "\n".join(parts)[:16000]
    else:
        try:
            return (msg.get_payload(decode=True) or b"").decode("utf-8", errors="ignore")[:16000]
        except Exception:
            return ""

def subject_from(msg):
    subj = msg.get("Subject", "")
    decoded = ""
    for s, enc in decode_header(subj):
        if isinstance(s, bytes):
            decoded += s.decode(enc or "utf-8", errors="ignore")
        else:
            decoded += s
    from_addr = msg.get("From", "")
    return decoded, from_addr

def thread_headers(msg):
    return {
        "message_id": msg.get("Message-Id"),
        "in_reply_to": msg.get("In-Reply-To"),
        "references": msg.get("References")
    }
