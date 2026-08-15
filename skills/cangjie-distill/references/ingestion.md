# Source ingestion

Normalize the source before method extraction. The distillation must be grounded in source text, not model memory.

## Supported source classes

### Plain-text sources

Read directly when the user supplies `.txt`, `.md`, `.srt`, `.vtt`, `.csv`, `.json`, or another readable text file. Preserve section, line, timestamp, or record boundaries when they can serve as provenance.

### PDF / EPUB / document files

Prefer an already available document-reading capability or an already installed extractor. Do not install a new dependency automatically.

For PDFs:

1. Try the host/workspace's native document reading path when available.
2. Otherwise inspect already installed CLI tools that can extract text.
3. Validate extraction by checking title/first section, middle content, and final section instead of trusting a non-empty file.
4. If text is image-only or badly garbled, stop the distillation stage and report that OCR/document extraction is required. Do not fabricate missing text.

For EPUB or other ebook formats, use an existing extractor if present and preserve chapter boundaries.

### Web articles

If the environment has a trusted fetch/browser capability, capture the article body plus title, author, date, and canonical source. Strip navigation, comments, and unrelated recommendations before extraction.

If only shell access is available, use already installed retrieval tools. Do not bypass authentication, paywalls, access controls, or anti-bot protections.

### Video / podcast / course URLs

Preferred order:

1. Use an already available transcript/subtitle or video-downloader Skill.
2. Use platform-provided subtitles/transcripts when available.
3. Use an already installed downloader/transcriber CLI.
4. If only media can be obtained and no transcription capability exists, report the missing transcription step rather than auto-installing software.

For Bilibili/YouTube/podcast/course material, keep timestamps or segment identifiers whenever possible.

## Normalized source package

Create under:

```text
~/.devspace/distill/<source-slug>/source/
```

Recommended files:

```text
manifest.yaml
normalized.txt
source-notes.md
```

`manifest.yaml` should include provenance metadata. `normalized.txt` is the text used by the pipeline. `source-notes.md` records extraction caveats such as missing chapters, transcript quality, OCR uncertainty, or unavailable metadata.

## Quality gate before extraction

Do not enter Stage 1 unless all are true:

- meaningful source text exists locally or is directly readable
- the beginning, middle, and end are represented
- obvious boilerplate/noise is removed or marked
- source identity is known well enough to name the audit package
- extraction limitations are recorded

When a source is partial, label it partial and scope every downstream claim to the available material.
