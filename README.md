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
thursday ask "ตอนนี้กี่โมง"    # ถามครั้งเดียวแล้วจบ
```

ธงที่ใช้ได้: `--model` `--effort` `--session` `--host` `--port` `--no-confirm` `-v`

### ในเทอร์มินัล

| คำสั่ง | ทำอะไร |
| --- | --- |
| `/tools` | รายการเครื่องมือทั้งหมด |
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

## ความสามารถ (Tools)

| กลุ่ม | เครื่องมือ |
| --- | --- |
| เครื่อง | `system_status` `list_processes` `open_app` `which` |
| ไฟล์ | `read_file` `write_file`* `list_files` `search_files` |
| เชลล์ | `run_shell`* |
| เวลา | `current_time` `set_timer` `set_reminder` `list_reminders` `cancel_reminder` |
| ความจำ | `remember_fact` `recall_facts` `forget_fact` `add_note` `search_notes` `delete_note` |
| เว็บ | `get_weather` `fetch_url` + `web_search` / `web_fetch` (ฝั่ง Anthropic) |

\* ต้องให้คุณกดอนุมัติก่อนทุกครั้ง

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
  agent.py        ลูปคุยกับ Claude: สตรีม, เรียก tool, กัน pause_turn/refusal
  config.py       ตั้งค่าทั้งหมดจาก environment
  memory.py       SQLite: ประวัติแชท, โน้ต, ความจำ, การเตือน
  persona.py      system prompt (ส่วนคงที่แยกจากส่วนที่เปลี่ยนทุกครั้ง)
  events.py       เหตุการณ์ที่ front end ทุกตัวใช้ร่วมกัน
  tools/          registry + เครื่องมือมาตรฐาน
  voice/          stt.py, tts.py, loop.py (คำปลุก + VAD)
  cli.py          เทอร์มินัล
  server.py       FastAPI + WebSocket
  web/index.html  หน้าเว็บ
plugins/          วางไฟล์ tool ของคุณที่นี่
tests/            pytest, ไม่แตะ network
```

## หมายเหตุด้านเทคนิค

- ใช้ **Claude Opus 5** (`claude-opus-5`) พร้อม adaptive thinking และ
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
pytest            # 81 tests, ไม่ต้องใช้ API key และไม่ต่อเน็ต
```

## License

MIT
