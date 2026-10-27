# Direct Browser Upload Guide (`github.com/mohdwaseem362/universal-agent-coordination`)

Aapke screenshot ke mutabiq aapne **`https://github.com/mohdwaseem362/universal-agent-coordination`** bana liya hai aur aap **Add file -> Upload files** (Direct Browser Upload) use kar rahe hain.

Maine aapki **`universal-agent-coordination.zip`** ko khas **Direct Browser Upload** ke hisaab se update kar diya hai:
1. Saare GitHub links aur badges me aapka exact repo URL (`mohdwaseem362/universal-agent-coordination`) laga diya gaya hai.
2. Zip ke andar se extra outer folder hata diya gaya hai (**Flat Root Structure**), taaki jab aap files drag-and-drop karein toh `README.md`, `package.json`, `src/`, `bin/`, `skills/` seedha main repo page par dikhein (kisi subfolder ke andar chhup na jayein).

## Step 1: Zip File ko Windows par Extract Karein

1. Niche diye gaye naye **`universal-agent-coordination.zip`** ko download karein.
2. Apne computer par `universal-agent-coordination.zip` par **Right-Click -> Extract All...** karein (maan lijiye `Downloads\universal-agent-coordination\` folder me).
3. **Bahut Important**: Zip file ko seedha GitHub par upload **MAT** kijiyega! Extracted folder (`Downloads\universal-agent-coordination\`) ke **andar** jayein, jahan aapko yeh files aur folders dikhenge:
   - `README.md`
   - `SKILL.md`
   - `package.json`
   - `SECURITY.md`
   - `CONTRIBUTING.md`
   - `GITHUB_PUBLISH_GUIDE.md`
   - `bin/`
   - `src/`
   - `skills/`
   - `integrations/`
   - `examples/`
   - `tests/`
   - `templates/`
   - `scripts/`
   - `.gitignore` & `.github/` *(Agar Windows File Explorer me `.gitignore` na dikhe toh Explorer ke upar **View -> Show -> Hidden items** par tick kar lein).*

## Step 2: GitHub par "Upload files" me Drag & Drop Karein

1. Apne GitHub page (`https://github.com/mohdwaseem362/universal-agent-coordination`) par **Add file -> Upload files** par click karein.
2. Apne extracted folder ke **andar** jaakar **`Ctrl + A`** (Select All) dabayein.
3. Saari selected files aur folders ko drag karke GitHub ke **"Drag files here to add them to your repository"** wale box me chhod dein (drop karein).
4. 5–10 second wait karein jab tak saari 43 files upload list me aa jayein.
5. Niche **Commit changes** section me:
   - First box me likhein: `feat: initial release of Universal Agent Coordination (@followprotocol) v1.0.0`
   - **"Commit directly to the `main` branch"** selected rehne dein.
   - Green **"Commit changes"** button par click karein!

Jaise hi aap **Commit changes** dabayenge:
- Aapke repo `https://github.com/mohdwaseem362/universal-agent-coordination` ke home page par poora professional `README.md`, Architecture Diagram, aur Badges live dikhne lagenge!

## Step 3: Ab Apne Projects me GitHub se Seedha Kaise Use Karein?

Ab jab aapka code `https://github.com/mohdwaseem362/universal-agent-coordination` par live hai, toh kisi bhi project me ise lagane ke liye bas yeh 2 commands chalayein:

```bash
# 1. Apne kisi bhi project ke root folder me jayein aur UAC clone karein
cd /path/to/your-project
git clone https://github.com/mohdwaseem362/universal-agent-coordination.git tools/universal-agent-coordination

# 2. Installer run karein (ye AntiGravity, OpenCode, Claude Code, Codex sab configure kar dega)
node ./tools/universal-agent-coordination/bin/uac.js install --level 2

# 3. Setup verify karein
node ./tools/universal-agent-coordination/bin/uac.js verify-setup
```

Aur phir apne IDE (AntiGravity, OpenCode, Claude Code, ya Codex) me seedha likhein:
```text
@followprotocol <aapka task>
```