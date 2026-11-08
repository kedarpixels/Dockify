-- A project's icon is the folder (the default), the favicon of an app the owner chose, or an upload.
-- There is no automatic pick any more. A project on the automatic pick ("auto" with no app chosen)
-- shows the folder from now on: those rows keep their values, which now mean the folder. A chosen
-- app and an upload stay as they are, and deleting the chosen app still clears it (0028).
-- An upload never keeps a chosen app; the API always cleared it, and this makes every row agree.
UPDATE "projects" SET "iconAppId" = NULL WHERE "iconChoice" = 'upload' AND "iconAppId" IS NOT NULL;
