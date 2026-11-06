# lexical-parse-integer 1.0.6 rustdoc fixture

Source: `https://docs.rs/crate/lexical-parse-integer/1.0.6/json.gz` (format 56).
SHA-256 of the decompressed original JSON bytes:
`7c521eaa0fd2dc9a3fe08ee45ebab154cac968b739c773436808a8637c384b3a`.

The JSON fixture retains the root, crate version, format version, all 107
`index` entries (including every `inner` value), and the 44 `paths` entries
whose IDs are referenced by the index. It removes documentation prose,
spans, attributes, links, and unrelated external paths. The original root's
eight public reexport targets absent from `index` remain absent; in particular,
`FromLexical` and `FromLexicalWithOptions` cannot be reconstructed from this
rustdoc document.
