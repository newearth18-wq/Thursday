# Thursday

ผู้ช่วยส่วนตัวสไตล์ JARVIS — คุยด้วยเสียง คุยในเทอร์มินัล หรือคุยผ่านหน้าเว็บ
ขับเคลื่อนด้วย Claude พร้อมเครื่องมือที่แตะเครื่องคุณได้จริง และระบบ plugin
ที่เพิ่มความสามารถใหม่ได้ด้วยการเขียนฟังก์ชันเดียว

> A Jarvis-like assistant with three front ends (voice, terminal, web), a
> sandboxed tool layer, persistent memory, and a one-function plugin system.

```
 ████████ ██   ██ ██    ██ ██████  ███████ ██████   █████  ██    ██
    ██    ███████ ██    ██ ██████  ███████ ██   ██ ███████   ████
    ██    ██   ██  ██████  ██   ██ ███████ ██████  ██   ██    ██
```

## ติดตั้ง (Install)

```bash
git clone <this repo> && cd Thursday
python3 -m venv .venv && source .venv/bin/activate

pip install -e .            # แกนหลัก + เทอร์มินัล
pip install -e ".[web]"     # เพิ่มหน้าเว็บ
pip install -e ".[voice]"   # เพิ่มเสียง (ไมค์ + ลำโพง)
pip install -e ".[vision]"  # เพิ่มการย่อรูป/สกรีนช็อต (Pillow)
pip install -e ".[all]"     # ทั้งหมด + เครื่องมือทดสอบ

cp .env.example .env        # แล้วใส่ ANTHROPIC_API_KEY
```

ต้องใช้ Python 3.10 ขึ้นไป

## ใช้งาน (Run)

```bash
thursday              # โหมดแชทในเทอร์มินัล (ค่าเริ่มต้น)
thursday voice        # โหมดเสียง: พูด "Thursday ..." เพื่อปลุก
thursday serve        # หน้าเว็บที่ http://127.0.0.1:8765
thursday tools        # ดูว่ามีความสามารถอะไรบ้าง
thursday profiles     # ดู profile และโมเดลที่อยู่เบื้องหลังแต่ละอัน
thursday providers    # เช็คว่าต่อ backend ไหนได้บ้างตอนนี้
thursday models       # ถามว่า provider ปัจจุบันมีโมเดลอะไร
thursday ask "ตอนนี้กี่โมง"    # ถามครั้งเดียวแล้วจบ

thursday --local                     # ทุกอย่างรันบน Ollama ในเครื่อง
thursday --provider groq             # ใช้ Groq
thursday --provider custom --base-url http://192.168.1.9:8000/v1
```

ธงที่ใช้ได้: `--provider` `--base-url` `--model` `--profile` `--routing` `--local`
`--effort` `--session` `--host` `--port` `--no-confirm` `-v`

### ในเทอร์มินัล

| คำสั่ง | ทำอะไร |
| --- | --- |
| `/tools` | รายการเครื่องมือทั้งหมด |
| `/see <path> [คำถาม]` | ให้ดูรูปแล้วถาม |
| `/routines` | routine ที่บันทึกไว้ |
| `/memory` | สิ่งที่ Thursday จำเกี่ยวกับคุณ |
| `/forget <key>` | ลบความจำหนึ่งอย่าง |
| `/reminders` | การเตือนที่ยังค้างอยู่ |
| `/clear` | ล้างบทสนทนานี้ |
| `/thinking` | เปิด/ปิดการแสดงความคิด |
| `/quit` | ออก |

### โหมดเสียง

พูดคำปลุก (`thursday` หรือ `เธิร์สเดย์`) ตามด้วยคำสั่ง หรือพูดคำปลุกเฉย ๆ
แล้วรอให้มันตอบ "Yes?" ก่อนสั่ง ตั้ง `THURSDAY_ALWAYS_LISTENING=1`
ถ้าไม่อยากใช้คำปลุกเลย

- **ฟัง** — ตัดเสียงเป็นประโยคด้วย VAD (ตรวจจับความดัง) แล้วถอดความด้วย
  faster-whisper ในเครื่อง (รองรับไทย/อังกฤษ) หรือ vosk / whisper.cpp
- **พูด** — เลือก backend อัตโนมัติ: piper → `say` (macOS) → espeak-ng → pyttsx3
  ถ้าไม่มีอะไรเลยจะพิมพ์คำตอบออกมาแทน
- **ตอบทันประโยค** — ข้อความที่สตรีมมาจะถูกตัดเป็นประโยคแล้วพูดออกทีละประโยค
  ไม่ต้องรอให้พิมพ์จบทั้งคำตอบ
- **ขัดจังหวะได้** — พูดใหม่ระหว่างที่มันกำลังพูดอยู่ เสียงเดิมจะถูกตัดทิ้ง

### หน้าเว็บ

`thursday serve` แล้วเปิด `http://127.0.0.1:8765` — สตรีมคำตอบผ่าน WebSocket
กดปุ่มไมค์เพื่อคุยด้วยเสียงโดยใช้ Web Speech API ของเบราว์เซอร์เอง
(ฝั่งเซิร์ฟเวอร์ไม่ต้องมีชุดเสียงใด ๆ) — ใช้ Chrome หรือ Edge จะได้ผลดีที่สุด

**แนบรูปได้** — วางรูป (Ctrl/Cmd-V), ลากมาวาง, หรือกดปุ่ม 📎 ได้สูงสุด 4 รูปต่อครั้ง
เซิร์ฟเวอร์ตรวจชนิดและขนาดไฟล์ก่อนส่งต่อเสมอ ไม่เชื่อสิ่งที่หน้าเว็บส่งมา

## ใช้โมเดลค่ายไหนก็ได้ รวมถึงในเครื่อง

Anthropic เป็น backend หลัก (ได้ของครบ: thinking, ค้นเว็บฝั่งเซิร์ฟเวอร์, prompt
caching) ส่วนที่เหลือคุยผ่านมาตรฐาน OpenAI chat API ซึ่งครอบคลุมเกือบทุกอย่าง

| ประเภท | provider |
| --- | --- |
| Native | `anthropic` |
| Hosted | `openai` `gemini` `groq` `openrouter` `deepseek` `mistral` `xai` `together` |
| **ในเครื่อง** | `ollama` `lmstudio` `llamacpp` `vllm` |
| อื่น ๆ | `custom` + `--base-url` (พร็อกซีบริษัท, เครื่องอื่นในวง LAN) |

```bash
# ในเครื่อง ไม่ต้องมี API key ไม่มีอะไรออกเน็ต
ollama serve && ollama pull qwen2.5
THURSDAY_PROVIDER=ollama THURSDAY_MODEL=qwen2.5 thursday

thursday providers    # บอกว่าตัวไหนพร้อม ตัวไหนขาดอะไร
```

`thursday providers` จะบอกตรง ๆ ว่าติดอะไร — คีย์ไม่ได้ตั้ง หรือต่อเซิร์ฟเวอร์
ในเครื่องไม่ได้ พร้อมคำสั่งที่ต้องรันเพื่อแก้

**สิ่งที่หายไปเมื่อไม่ได้ใช้ Anthropic** — ระบบบอกชัดเจนแทนที่จะเงียบ ๆ:
`web_search`/`web_fetch` เป็น server tool ของ Anthropic จึงไม่ถูกส่งให้ provider อื่น,
thinking block ที่ replay ได้มีแค่ของ Anthropic (ค่ายอื่นสตรีม reasoning ให้ดูได้
แต่ไม่เก็บเป็นบล็อก), prompt caching และ mid-conversation system message
ก็เฉพาะ Anthropic เช่นกัน

ภายในโปรเจกต์ใช้รูปแบบข้อความของ Anthropic เป็นมาตรฐานกลาง (มันแสดงอะไรได้เยอะสุด)
แล้วแปลงที่ขอบของแต่ละ provider — ทาง Anthropic จึงไม่สูญเสียอะไรเลย

## Profiles — เลือกสมองให้เหมาะกับงาน

profile หนึ่งอันมัดรวม provider + โมเดล + ระดับความคิด + tool ที่ใช้ได้ + สไตล์การตอบ

| profile | ใช้ตอนไหน | เบื้องหลัง |
| --- | --- | --- |
| `default` | งานทั่วไป | Opus 5, effort กลาง, ครบทุก tool |
| `quick` | ถามเวลา/ตั้งเตือน/ตอบสั้น | Haiku 4.5, effort ต่ำ, tool จำกัด, ไม่ค้นเว็บ |
| `deep` | ค้นคว้า วิเคราะห์ วางแผน | Opus 5, effort xhigh, ครบทุก tool |
| `coder` | อ่าน/เขียน/รันโค้ด | Opus 5, effort สูง, tool ไฟล์+ระบบ |
| `private` | ห้ามหลุดออกจากเครื่อง | **Ollama ในเครื่อง**, ตัด tool ที่แตะเน็ตทิ้งหมด |

เลือกได้สามทาง:

```bash
thursday --profile deep          # ปักไว้ตั้งแต่เริ่ม
/profile coder                   # ปักระหว่างคุย (/profile เปล่า = กลับเป็นอัตโนมัติ)
"ใช้โหมด private ที"              # พูดในประโยคเลย
```

หรือปล่อยให้ router เลือกเอง (`THURSDAY_ROUTING`):

- `off` — ใช้ profile เดียวตลอด
- `keyword` (ค่าเริ่มต้น) — จับคำที่แต่ละ profile ประกาศไว้ ฟรีและทันที รองรับไทย
- `llm` — คีย์เวิร์ดก่อน ถ้าไม่เข้าค่อยถามโมเดลเล็ก ๆ ให้จัดหมวด

**การจำกัด tool บังคับใช้จริงตอนรัน** ไม่ใช่แค่ไม่ส่งรายการไปให้โมเดล — ถ้าโมเดล
เรียก tool ที่ profile นั้นห้าม การเรียกจะถูกปฏิเสธก่อนฟังก์ชันจะทำงาน
`private` จึงหมายความว่าไม่มีอะไรออกเน็ตจริง ๆ

เพิ่ม profile ของตัวเองได้ที่ `profiles.json` (ดูตัวอย่างใน `profiles.example.json`)
ชื่อซ้ำกับของเดิม = แก้ทับเฉพาะฟิลด์ที่ใส่

## ความสามารถ (Tools)

| กลุ่ม | เครื่องมือ |
| --- | --- |
| เครื่อง | `system_status` `list_processes` `open_app` `which` |
| ไฟล์ | `read_file` `write_file`* `list_files` `search_files` |
| เชลล์ | `run_shell`* |
| **การมองเห็น** | `take_screenshot`* `look_at_image` |
| **เดสก์ท็อป** | `read_clipboard` `write_clipboard` `set_volume` `media_control` `show_notification` `lock_screen` |
| เวลา | `current_time` `set_timer` `set_reminder` `list_reminders` `cancel_reminder` |
| **Routines** | `save_routine` `run_routine` `list_routines` `delete_routine` |
| ความจำ | `remember_fact` `recall_facts` `forget_fact` `add_note` `search_notes` `delete_note` |
| เว็บ | `get_weather` `fetch_url` + `web_search` / `web_fetch` (ฝั่ง Anthropic) |

\* ต้องให้คุณกดอนุมัติก่อนทุกครั้ง

### การมองเห็น

> "Thursday ดูหน้าจอหน่อย นี่ error อะไร"

ถ่ายหน้าจอ (ต้องอนุมัติก่อน) หรืออ่านไฟล์รูปในเวิร์กสเปซ รูปถูกย่อเหลือ 1568px
และแปลงเป็น JPEG ก่อนส่งเสมอ — ส่งใหญ่กว่านั้นเปลืองเปล่า เพราะฝั่ง API ย่อให้อยู่แล้ว
รองรับ `screencapture` (macOS), `grim`, `spectacle`, `gnome-screenshot`, `scrot`,
`import` และ Pillow เป็นตัวสำรอง

base64 ของรูป **ไม่ถูกเก็บลงประวัติ** — เก็บแค่ placeholder ไว้แทน
ฐานข้อมูลจึงไม่บวมและไม่ replay รูปเก่าซ้ำ ๆ

### Routines

บันทึกชุดคำสั่งไว้เรียกด้วยชื่อ ไม่ใช่ macro ตายตัว แต่เป็นคำสั่งที่ Thursday
เอาไปทำต่อด้วย tool อะไรก็ได้ที่จำเป็น

> "จำไว้นะ routine ตอนเช้าคือ บอกอากาศกรุงเทพ แล้วอ่านเตือนความจำวันนี้"
> — จากนั้นแค่พูดว่า "รัน routine ตอนเช้า"

### เตือนความจำแบบทำซ้ำ

`set_reminder` รับ `repeat` เป็น `once` / `hourly` / `daily` / `weekly` / `monthly`
ถ้าปิดเครื่องแล้วพลาดไปหลายรอบ ระบบจะข้ามไปรอบถัดไปในอนาคต ไม่ไล่เตือนย้อนหลังรัว ๆ
และทุกการเตือนจะเด้ง notification ของ OS ด้วย ไม่ใช่แค่ในเทอร์มินัล

## เขียน tool เพิ่มเอง

วางไฟล์ `.py` ไว้ใน `plugins/` — แค่นั้น ดูตัวอย่างที่
`plugins/example_smart_home.py`

```python
from thursday.tools import tool

@tool
def brew_coffee(strength: int = 3, milk: bool = False) -> str:
    """ชงกาแฟให้หนึ่งแก้ว

    Args:
        strength: ความเข้ม 1-5
        milk: ใส่นมไหม
    """
    return f"กำลังชง (เข้ม {strength})"
```

JSON schema ถูกสร้างจาก type hints และ docstring ให้อัตโนมัติ ไม่ต้องเขียนเอง

- `@tool(dangerous=True)` → ถามผู้ใช้ก่อนรันเสมอ
- รับพารามิเตอร์ `ctx: ToolContext` → เข้าถึง settings, memory และ
  `await ctx.request_confirmation(...)` ได้ (พารามิเตอร์นี้ถูกซ่อนจาก Claude)
- ฟังก์ชัน `async def` ใช้ได้เหมือนกัน ฟังก์ชันธรรมดาจะถูกรันในเธรดแยก

## ความปลอดภัย

- เครื่องมือไฟล์ออกนอก `THURSDAY_WORKSPACE` ไม่ได้ (กัน `../` และ symlink ด้วย
  การ resolve จริง)
- `write_file` และ `run_shell` ต้องได้รับการอนุมัติจากคุณก่อนเสมอ — ในเทอร์มินัล
  เป็นคำถาม y/N บนเว็บเป็น dialog ในโหมดเสียงถามออกมาเป็นคำพูด
- คำสั่งทำลายล้าง (`rm -rf /`, `mkfs`, fork bomb ฯลฯ) ถูกปฏิเสธก่อนที่จะถามด้วยซ้ำ
- ปิดเชลล์ทั้งหมดได้ด้วย `THURSDAY_ALLOW_SHELL=0`

## โครงสร้าง

```
thursday/
  agent.py        ลูปคุย: สตรีม, เรียก tool, กัน pause_turn/refusal
  providers/      base.py, anthropic_provider.py, openai_compat.py
  profiles.py     profile และการสืบทอดค่า
  router.py       เลือก profile ต่อเทิร์น
  config.py       ตั้งค่าทั้งหมดจาก environment
  memory.py       SQLite: ประวัติแชท, โน้ต, ความจำ, การเตือน
  persona.py      system prompt (ส่วนคงที่แยกจากส่วนที่เปลี่ยนทุกครั้ง)
  events.py       เหตุการณ์ที่ front end ทุกตัวใช้ร่วมกัน
  notify.py       desktop notification ข้ามแพลตฟอร์ม
  tools/          registry + เครื่องมือมาตรฐาน (มี vision, desktop, routines)
  voice/          stt.py, tts.py, loop.py (คำปลุก + VAD)
  cli.py          เทอร์มินัล
  server.py       FastAPI + WebSocket
  web/index.html  หน้าเว็บ
plugins/          วางไฟล์ tool ของคุณที่นี่
tests/            pytest, ไม่แตะ network
```

## หมายเหตุด้านเทคนิค

- ค่าเริ่มต้นใช้ **Claude Opus 5** (`claude-opus-5`) พร้อม adaptive thinking และ
  `effort: medium` ซึ่งเป็นจุดที่สมดุลสำหรับผู้ช่วยที่ต้องตอบไว —
  ปรับได้ด้วย `--effort` หรือ `THURSDAY_EFFORT`
- เปิด **server-side fallback** ไว้ ถ้าคำขอถูกปฏิเสธ (`stop_reason: refusal`)
  จะถูกส่งต่อไปโมเดลสำรองอัตโนมัติแทนที่จะได้คำตอบว่าง
- **prompt caching**: บุคลิกและรายการ tool เป็น prefix ที่ไม่เปลี่ยน ส่วนเวลา
  ปัจจุบันและความจำถูกส่งเป็น mid-conversation system message ต่อท้าย
  จึงไม่ล้าง cache ทุกเทิร์น (โมเดลที่ไม่รองรับจะ fold เข้า user turn แทน)
- **ค้นเว็บ** ใช้ server tool `web_search_20260209` / `web_fetch_20260209`
  ของ Anthropic — ไม่ต้องมี API key ของ search engine

## ทดสอบ

```bash
pip install -e ".[dev]"
pytest            # 165 tests, ไม่ต้องใช้ API key และไม่ต่อเน็ต
```

เทสต์ของ provider ยิงผ่าน socket จริงไปยังเซิร์ฟเวอร์ OpenAI-compatible ปลอม
(`tests/fake_openai_server.py`) จึงครอบคลุม SSE, tool call ที่ถูกหั่นเป็นชิ้น
และการรันครบลูปบนโมเดลในเครื่อง โดยไม่ต้องติดตั้ง Ollama

## License

MIT
