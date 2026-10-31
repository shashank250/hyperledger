import sys, json, fitz

raw = sys.stdin.buffer.read()
doc = fitz.open(stream=raw, filetype="pdf")
if len(doc) > 80:
    raise ValueError("PDF is limited to 80 pages")
text = "\n".join(page.get_text("text", sort=True) for page in doc)
print(json.dumps({"text": text, "pages": len(doc)}))
