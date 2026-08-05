# Translation glossary — one term per concept, per language

Nine locales, ~44,000 lines of copy, and every concept below had **2–6 competing
renderings** before this file existed. Drift is what a reader actually notices:
not a stiff sentence, but a site that calls the same thing three names across
three pages — and, worse, a guide that tells them to click a button whose label
the UI never shows.

The prose in this repo is good. It was audited language-by-language in 2026-07
and every locale came back "written by a native speaker, not machine-translated."
So this file is **not** a style guide for how to write. It fixes the one thing
that audit found in all nine locales at once: nobody had ever decided what to
call things.

**Rule: pick the row, use the row.** If a term genuinely does not fit a context,
change the row here first, then change every file — never just the one string.

The settled register decisions below are enforced at build time by
`../register-glossary.test.mjs`, over the SPA tables and this content tree at
once. It covers the mechanically decidable rows only — changing one of those
rows means changing that test in the same commit, or the corpus and the rule
disagree. Everything else here is still on the reviewer.

## Register decisions (settled — do not relitigate per file)

| Locale | Decision |
|---|---|
| `zh` | `你`, never `您`. Full-width `，：；？（）`. Quotes `「」`. Write `其他` (not the `其-它` variant). |
| `ja` | です・ます throughout. **Legal pages use `お客様`; everything else drops the pronoun** — never `あなた`, never `あなたたち`. `当社` or `Relayium` for first person, never `私たち`/`御社`. |
| `ko` | 합니다체. Never `당신` — drop the possessive or use `내`/`본인`/`기존`. Legal keeps `귀하`. No space between a Latin token and its particle: `serve를`, not `serve 를`. |
| `de` | **`du` everywhere except `legal/`, which keeps `Sie`.** That split is deliberate. |
| `fr` | `vous` throughout (zero tutoiement today — keep it). Non-breaking space before `: ; ! ?` and inside `1 000` / `256 Mo`. |
| `es` | `tú` singular throughout. **No `vosotros` and no `ustedes`** — reformulate (`ambos lados`, `las dos partes`). Peninsular lexis (`ordenador`, `móvil`, `vídeo`). Quotes `« »`. |
| `pt` | pt-BR only (`arquivo`, `tela`, `celular`, `registrar`, `porta`). `você`, never `vocês`. `online`/`offline`, not `on-line`. Quotes `“ ”`. `o Relayium` (product) / `a Relayium` (legal entity). |
| `ar` | MSA. Tanwīn as `ًا` (mark before alif), never `اً`. Quotes `« »`. Attach waw to Latin: `وmacOS`, not `و macOS`. Western digits, `1,000`. |

## Core concepts

| EN | zh | ja | ko | de | fr | es | pt | ar |
|---|---|---|---|---|---|---|---|---|
| pairing code | 配对码 | ペアリングコード | 페어링 코드 | Pairing-Code | code d'appairage | código de emparejamiento | código de emparelhamento | رمز الاقتران |
| verification code (SAS) | 校验码（SAS） | 検証コード（SAS） | 검증 코드 | Verifizierungscode | code de vérification | código de verificación | código de verificação | رمز التحقق |
| relay (noun) | 中继 | リレー | 릴레이 | das Relay *(neuter)* | relais | retransmisor | retransmissor | مُرحِّل |
| rendezvous | 会合 | ランデブー | 랑데부 | Rendezvous | rendez-vous | punto de encuentro | encontro | تعارف |
| daemon direct | daemon 直连 | デーモン直結 | 데몬 다이렉트 | daemon-direct | daemon-direct | daemon directo | daemon direto | daemon direct |
| burn after read | 阅后即焚 | 閲覧後削除 | 열람 후 삭제 | Burn-after-read | autodestruction après lecture | destrucción tras la lectura | autodestruição após a leitura | الحذف بعد القراءة |
| stored download link | 下载链接 | ダウンロードリンク | 다운로드 링크 | Download-Link | lien de téléchargement | enlace de descarga | link de download | رابط التنزيل |
| end-to-end encrypted | 端到端加密 | エンドツーエンド暗号化 | 종단간 암호화 | Ende-zu-Ende-verschlüsselt | chiffré de bout en bout | cifrado de extremo a extremo | criptografado de ponta a ponta | مُشفَّر من الطرف إلى الطرف |
| zero-knowledge | 零知识 | ゼロ知識 | 영지식 | Zero-Knowledge | à divulgation nulle | conocimiento cero | conhecimento zero | معرفة صفرية |
| peer-to-peer | 点对点 | P2P | P2P | Peer-to-Peer | pair-à-pair | de igual a igual | ponto a ponto | من الند للند |
| ciphertext | 密文 | 暗号文 | 암호문 | Chiffretext | texte chiffré | texto cifrado | texto cifrado | نص مُشفَّر |
| chunk | 数据块 | チャンク | 청크 | Block | bloc | bloque | bloco | كتلة |
| self-host | 自托管 | セルフホスト | 자체 호스팅 | selbst hosten | auto-héberger | autoalojar | auto-hospedar | الاستضافة الذاتية |
| pinned TLS | 证书固定的 TLS | 証明書ピンニング付き TLS | 인증서 고정 TLS | TLS mit Pinning | TLS avec épinglage | TLS con anclaje | TLS com fixação | TLS مثبَّت |
| listener | 监听端 | リスナー | 리스너 | Listener | processus à l'écoute | proceso a la escucha | processo à escuta | مُستمِع |
| resume (transfer) | 断点续传 | レジューム | 이어받기 | fortsetzbar | reprise | reanudación | retomada | استئناف |
| same network / LAN | 同一网络 | 同一ネットワーク | 같은 네트워크 | dasselbe Netzwerk | même réseau | misma red | mesma rede | الشبكة نفسها |
| plan (billing) | 套餐 | プラン | 요금제 | Tarif | offre | plan | plano | الباقة |
| sign in | 登录 | サインイン | 로그인 | anmelden | se connecter | iniciar sesión | entrar | تسجيل الدخول |
| handshake | 握手 | ハンドシェイク | 핸드셰이크 | Handshake | poignée de main | handshake | handshake | مصافحة |
| by design | 刻意如此 | 設計上 | 설계상 | von Grund auf | par conception | por diseño | por decisão de projeto | بحكم التصميم |

## Gendered loanwords (get these right)

- `de`: **das** Relay, **die** CLI, **der** Node.
- `fr`: **la** CLI, **le** relais.
- `es`: **la** CLI, **el** relay.
- `pt`: **a** CLI, **o** link, **um IP público** *(masculine — `IP pública` is wrong)*.

## UI labels must match the shipped app

Never quote an English label in translated prose. The SPA already ships every
one of these in `src/lib/i18n/<lang>.ts` — copy the value from there. `guides-own-node`
was telling readers in five languages to look for `My Nodes` / `Add node` /
`Online` / `Only use my own nodes for relay/storage`, none of which their UI
displays. Keys: `me.nodesTitle`, `me.addNode`, `me.nodeOnline`, `me.strictLabel`.

## Code-block comments

**Translate them.** Half the corpus already does and half does not, which is the
only reason this needs saying. Shell commands, flags, systemd directives, paths
and literal program output stay in English — only the `#` comments are prose.

## Arabic: inline placeholders need bidi isolation

A Latin run ending in `>` or `]` immediately before Arabic text puts a
bidi-neutral character between an LTR and an RTL run. It resolves to the RTL base
level, gets **mirrored** (`>` becomes `<`) and **jumps to the wrong side**. Wrap
inline placeholders in U+200E: `‎--ttl <duration>‎`. Twelve of these render
visibly broken today. Also prefix any `title`/`description` that opens with a
Latin word with U+200F, or the browser tab and the search result render LTR-based
with the punctuation in the wrong place.
