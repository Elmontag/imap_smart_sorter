from sqlmodel import select


def test_known_suggestion_uids_are_scoped_by_folder(backend_env):
    database = backend_env["database"]
    Suggestion = database.Suggestion

    try:
        database.save_suggestion(Suggestion(message_uid="1", src_folder="INBOX"))
        database.save_suggestion(Suggestion(message_uid="2", src_folder="Archive"))
        database.save_suggestion(Suggestion(message_uid="3", src_folder=None))

        mapping = database.known_suggestion_uids_by_folder()
        assert mapping["INBOX"] == {"1"}
        assert mapping["Archive"] == {"2"}
        assert mapping[None] == {"3"}

        all_uids = database.known_suggestion_uids()
        assert all_uids == {"1", "2", "3"}
    finally:
        with database.get_session() as session:
            for uid in ("1", "2", "3"):
                record = session.exec(
                    select(Suggestion).where(Suggestion.message_uid == uid)
                ).first()
                if record is not None:
                    session.delete(record)
            session.commit()
