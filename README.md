# Blueberry Browser

> **⚠️ Disclaimer:** I'm not proud of this codebase! It was built in 3 hours. If you have some time left over in the challenge, feel free to refactor and clean things up!

https://github.com/user-attachments/assets/bbf939e2-d87c-4c77-ab7d-828259f6d28d

---

## Overview

You are the **CTO of Blueberry Browser**, a Strawberry competitor. Your mission is to add a feature to Blueberry that makes it superior & more promising than Strawberry.

But your time is limited—Strawberry is about to raise a two billion dollar Series A round from X-Separator, B17Å and Sequoiadendron giganteum Capital.

## 🎯 Task

Your job is to **clone this repo** and add a unique feature. Some ideas are listed below.

It doesn't need to work 100% reliably, or even be completely done. It just has to:

- Show that you are creative and can iterate on novel ideas fast
- Demonstrate good system thinking and code practices  
- Prove you are a capable full stack and/or LLM dev

Once you're done, we'll book a call where you'll get to present your work!

If it's cracked, we might just have to acquire Blueberry Browser to stay alive 👀👀👀

### ⏰ Time

**1-2 weeks** is ideal for this challenge. This allows you to work over weekends and during evenings in your own time.

### 📋 Rules

You are allowed to vibe code, but make sure you understand everything so we can ask technical questions.

## 💡 Feature Ideas

### **Browsing History Compiler**
Track the things that the user is doing inside the browser and figure out from a series of browser states what the user is doing, and perhaps how valuable, repetitive tasks can be re-run by an AI agent.

*Tab state series → Prompt for web agent how to reproduce the work*

### **Coding Agent**
Sidebar coding agent that can create a script that can run on the open tabs.

Maybe useful for filling forms or changing the page's style so it can extract data but present it in a nicer format.

### **Tab Completion Model**
Predict next action or what to type, like Cursor's tab completion model.

### **Your Own Idea**
Feel free to implement your own idea!

> Wanted to try transformers.js for a while? This is your chance! 

> Have an old cool web agent framework you built? Let's see if you can merge it into the browser!

> Think you can add a completely new innovation to the browser concept with some insane, over-engineered React? Lfg!

Make sure you can realistically showcase a simple version of it in the timeframe. You can double check with us first if uncertain! :)

## 💬 Tips

Feel free to write to us with questions or send updates during the process—it's a good way to get a feel for working together.

It can also be a good way for us to give feedback if things are heading in the right or wrong direction.

---

## 🚀 Project Setup

### Install
```bash
$ bun install
```

### Development
```bash
$ bun dev
```

**Add an OpenAI API key to `.env`** in the root folder (see `.env.example`).

Strawberry will reimburse LLM costs, so go crazy! *(Please not more than a few hundred dollars though!)*

### Microsoft Fara-7B (local computer-use agent)

Set `LLM_PROVIDER=fara` in `.env`. Blueberry talks to an **OpenAI-compatible** server at `/v1/chat/completions` (vLLM, Ollama, or LM Studio).

#### Option A — ~8–12GB VRAM (recommended): Ollama

```bash
ollama pull maternion/fara:7b   # Q4_K_M, ~6GB
ollama serve
```

```env
LLM_PROVIDER=fara
LLM_BACKEND=ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=maternion/fara:7b
```

In Ollama, set context length to **≥15000** and temperature **0** if your client exposes those settings.

#### Option B — 16GB+ VRAM: vLLM (reduced memory)

```bash
pip install "vllm>=0.10.0"
vllm serve "microsoft/Fara-7B" --port 5000 --dtype half --max-model-len 4096 --gpu-memory-utilization 0.85
```

```env
LLM_PROVIDER=fara
LLM_BACKEND=vllm
LLM_BASE_URL=http://127.0.0.1:5000/v1
LLM_MODEL=microsoft/Fara-7B
```

If you still OOM, try `--tensor-parallel-size 2` (multi-GPU) or switch to Option A (GGUF via Ollama).

The sidebar agent uses the `computer_use` tool. **On Ollama (low VRAM)** it uses Ollama's native JSON mode and text-only browser state (URL/title/action results) instead of screenshots or OpenAI tool schemas, because Q4 Fara often collapses into gibberish with vision + tool payloads. vLLM keeps the fuller screenshot-based Fara loop.
