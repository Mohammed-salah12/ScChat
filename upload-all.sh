#!/bin/bash

BUCKET_NAME="media"
LOCAL_DIR="./media"

find "$LOCAL_DIR" -type f | while read -r file; do
  # Remove ./media/ from the file path to get the key
  key="${file#$LOCAL_DIR/}"
  echo "🚀 Uploading: $file → $key"
  wrangler r2 object put "$BUCKET_NAME/$key" --file "$file" --remote
done
