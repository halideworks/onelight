CREATE INDEX renditions_blob_key_idx ON renditions(blob_key);
CREATE INDEX comment_attachments_blob_key_idx ON comment_attachments(blob_key);
CREATE INDEX comment_attachments_comment_idx ON comment_attachments(comment_id);
