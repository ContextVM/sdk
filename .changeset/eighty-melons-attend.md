---
'@contextvm/sdk': patch
---

feat(transport): add category tag support to common schema announcements

Add optional categories parameter to CommonToolSchemasOptions that enables
including CEP-15 category tags in tools/list event announcements. Categories
are normalized (trimmed whitespace) and deduplicated before being appended
as 't' tags after the common-schema meta namespace tag. Includes unit and
integration tests for the new functionality.