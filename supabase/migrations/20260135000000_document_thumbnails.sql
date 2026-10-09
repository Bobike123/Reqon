-- A document (PDF) may now have a preview image (Files page; SMC folder import).
--
-- Until now task_attachments_thumb_for_kind said "a document has NO thumbnail, a photo or video MUST have one".
-- The Files page shows the first page of each PDF as a picture, so a document may carry a thumbnail too.
-- Photos and videos still must. The in-app upload path is unchanged: request_attachment_upload() gives a new
-- document no thumbnail key, and confirm_attachment() only demands the thumbnail when the row has one.
-- Additive and reversible: docs/ultraplan/rollbacks/20260135000000_document_thumbnails_down.sql
alter table task_attachments drop constraint if exists task_attachments_thumb_for_kind;
alter table task_attachments
  add constraint task_attachments_thumb_for_kind
  check (kind = 'document' or thumb_key is not null);
