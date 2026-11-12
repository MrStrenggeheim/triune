# Triune licensing

Triune is source-available software with separately licensed inherited code and new additions.
The combined distribution is not offered under a single permissive open-source license.

| Material | Terms |
| --- | --- |
| Omnigent and custom baseline `4646d0bbd9492eed3bff0e95d39f8ac85d1b1eb8` | Apache-2.0 and existing third-party terms |
| New own copyrightable changes after that baseline | PolyForm-Noncommercial-1.0.0 |
| Existing SDKs and separately marked files | Their declared Apache or third-party licenses |

## Source boundaries

The retained Git history identifies the Apache baseline exactly.
`git show 4646d0bbd:<path>` retrieves its version of an inherited file.
`git diff 4646d0bbd -- <path>` identifies later changes; the Triune license applies only to material we own and can license.
Inherited files with new Triune changes contain material under both sets of terms.
A rename, rebrand or extensive edit does not erase upstream copyright or attribution.
New own files default to PolyForm unless explicitly marked otherwise; third-party files remain exceptions.

The release's [modification record](MODIFICATIONS.md) identifies the baseline and release changes.
Each modified inherited code file carries a Triune modification notice; original notices are retained.
Existing Apache grants, including those covering previously published custom features, remain available and irrevocable.
The noncommercial terms do not restrict anyone's independently obtained Apache copy or inherited portions used separately under Apache.

## Noncommercial use and attribution

The unmodified [PolyForm Noncommercial License 1.0.0](LICENSES/PolyForm-Noncommercial-1.0.0.txt) permits use, changes and redistribution for its permitted purposes.
Read its Noncommercial Organizations clause: specified educational, charitable, research and government organizations also have express permission.
Commercial uses outside the license's permitted purposes need separate permission from the applicable copyright holder.

When sharing any PolyForm-covered portion, provide its license text or URL and preserve this plain-text line:

```text
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
```

The required notice supplies the project's name, author and canonical reference.
This standard license requires passing attribution to recipients; it does not require a permanent UI badge, advertising or an academic citation.
You may also credit Triune in documentation or an About screen.

## Upstream and third-party compliance

Distribute [the Apache license](LICENSES/Apache-2.0.txt) and [NOTICE](NOTICE) with applicable inherited material.
Preserve source copyright, patent, trademark and attribution notices, and state which inherited files were changed.
The original Omnigent and third-party attributions are retained in NOTICE; Triune is independently maintained and does not imply endorsement.
Dependency licenses remain applicable when you distribute those dependencies.

## Contributions

Unless separately agreed in writing, submit new own contributions under PolyForm Noncommercial 1.0.0, with the required Triune notice retained.
Only contribute material you have the right to license; identify any third-party material and its terms.
This policy does not relabel inherited Apache code or require assigning copyright.

## Primary references

- [Apache License 2.0, sections 2, 4 and 6](https://www.apache.org/licenses/LICENSE-2.0).
- [Official PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).
