
from database import upsert_folder_profile
def update_profiles_on_accept(folder: str, embedding):
    if embedding:
        upsert_folder_profile(folder, embedding)
