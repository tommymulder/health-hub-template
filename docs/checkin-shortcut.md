# Log Morning (iPhone Shortcut)

Checked against Apple's Shortcuts guides (October 2026; re-check them, iOS changes): [Event triggers](https://support.apple.com/guide/shortcuts/apd932ff833f/ios), [Add automations](https://support.apple.com/guide/shortcuts/apdfbdbd7123/ios), and [Choose from Menu](https://support.apple.com/guide/shortcuts/apdd7bf369da/ios). iOS 26 also lets you attach an automation from inside a shortcut (Edit, then Automation). If your screen uses the older Automation tab instead, the labels below are the same. The one thing these pages do not settle is whether Choose from Menu appears when the phone is still locked. That test is yours: write down what happened.

The key in these shortcuts (`CHECKIN_KEY`, header `x-checkin-key`) can only save a rating, ask whether today is already logged, and log a bathroom trip (section 6). It cannot read your health data. Generate it yourself with `openssl rand -hex 32`, put it in 1Password and in Vercel, and paste it into the shortcut from 1Password. Do not paste it into a chat.

The one automation suggested here runs at 9:00 daily (section 2). An alarm automation is possible but not needed.

## 1. The shortcut, "Log Morning"

1. Open Shortcuts. Tap the plus button, then Rename, and name it `Log Morning`.
2. Add **Choose from Menu**. Set the prompt to `How did you feel when you woke up?`
3. Replace the two default items with these five, top to bottom: `5 Great`, `4 Good`, `3 OK`, `2 Rough`, `1 Awful`.
4. Under each item, add a **Text** action containing only the digit for that item (`5` under 5 Great, `4` under 4 Good, and so on). The menu then hands the digit to the next action. Do not send the words. The hub rejects `good` and `3.5`.
5. Below the whole menu (not inside one branch), add **Ask for Input**. Prompt: `Anything to add?` Input type: Text. Leave it blank and tap Done when you have nothing to say. If Done stays grey on an empty field, type a space. A blank note is dropped.
6. Add **Get Contents of URL**.
   - URL: `https://YOUR-APP.vercel.app/api/checkin`
   - Method: POST
   - Headers: add a header named `x-checkin-key`. The value is your `CHECKIN_KEY`.
   - Request Body: JSON.
   - Add a field `rating` (Text) and set it to the Choose from Menu result (the digit from the Text action).
   - Add a field `note` (Text) and set it to the Provided Input from Ask for Input.
7. Add **Get Dictionary from Input**. Its input is Contents of URL. This turns the reply into fields you can pick from.
8. Add **Get Dictionary Value** (search for "dictionary value"). It reads "Get Value for Key in Dictionary."
   - Tap the key and type `message` in lowercase.
   - Tap Dictionary and choose the Dictionary from the previous step. If that variable is not offered, choose Contents of URL.
9. Add **Show Notification**. The action arrives with the words `Hello World` already filled in. That line is the message. There is no field named Body.
   - Tap `Hello World`, delete it, then long-press the empty line and choose Select Variable (or tap the variable button). Pick **Dictionary Value**. That is the sentence `Saved 4/5 (Good) for Thu Oct 15`.
   - If a line labeled Title is showing, leave it blank, or type `Morning`. Play Sound can stay on.
   - Use the Show Notification action from Shortcuts itself. If the one you added has Subtitle, a schedule, or the words "please read the action description," that is a different app's action. Delete it and add the Shortcuts one. Show Alert is also the wrong action: it stops and waits for you to tap OK.

Run it once from the Shortcuts app while the phone is unlocked. You should see the notification. Running it again the same day replaces the rating. That is expected.

## 2. Every day at 9:00

The simplest setup is **no check, just ask.** The 9:00 automation runs Log Morning every day. If you already rated, tap **Cancel** on the menu (nothing is saved). If you answer again, it replaces the earlier rating, and the notification says "replacing 4/5 (Good)".

1. Shortcuts → **Automation** tab. If an older 9:00 automation exists, open it. Otherwise tap **+**.
2. Trigger: **Time of Day** → 9:00 AM → **Daily**. You can add a second trigger to the same automation: **Sleep → Is Turned Off**, so the question comes as you get up. 9:00 is then the backup; on days both fire, Cancel the second one.
3. Choose **Run Immediately** (not "Run After Confirmation"). While testing, turn **Notify When Run on**, so a banner proves it started.
4. Action: **Run Shortcut → Log Morning**. Delete any other steps (Get Contents of URL, Get Dictionary, Text, If, Otherwise). Nothing else is needed.
5. Make sure the automation is **switched on** in the Automation list.
6. Test: tap the automation, then ▶ (or wait for 9:00). The menu should open.
7. If you made a separate shortcut called "Log Morning Automation" for the old check, you can delete it.

If the phone is locked at 9:00, the menu may wait until you unlock it. If it still doesn't appear, use the Home Screen button or "Hey Siri, log my morning", or let Claude ask you in your first chat.

(Why no "already logged?" check: a first version asked the hub `GET /api/checkin/today` and only opened the menu on unrated days. Shortcuts mishandled that check, first with JSON `false` and then with the text comparison, so it was dropped. The route still exists but isn't used.)

## 3. Other ways to log

- Home Screen or Lock Screen button for `Log Morning`.
- The Action Button is taken by `Log Trip` (section 6).
- "Hey Siri, log my morning".
- Claude. On the first conversation of the day, if you have not rated yet, it should ask before it shows sleep.

## 5. After the server is deployed

These routes answer 404 until the modules are turned on (`HUB_MODULES=checkins,events`), and do nothing until `CHECKIN_KEY` is in Vercel and the app is redeployed. A new Claude chat (or reconnecting the connector) is required before `log_checkin`, `get_checkins`, and `get_feel_vs_ring` show up. Update your project instructions from `docs/coach-instructions.txt` (the MORNINGS and TRIPS sections).

## 6. Log Trip (the Action Button, every bathroom trip, day and night)

The idea: the iPhone stays on the nightstand. Each time you get back into bed you press and hold the Action Button. The phone buzzes. You don't unlock it or look at it. During the day the phone can stay in your pocket. **Log every trip, day and night** (the example here is bathroom trips; the endpoint takes a `type`, and `bathroom` is the one type the hub knows). The hub stamps the time on arrival (the shortcut sends no clock), and a second press within 60 seconds is ignored.

The same `CHECKIN_KEY` is used. If it is already in the shortcut `Log Morning`, copy it from 1Password again. Never paste it into a chat.

**Build the shortcut**

1. Open Shortcuts. Tap the plus button, then Rename, and name it `Log Trip`.
2. Add **Get Contents of URL**.
   - URL: `https://YOUR-APP.vercel.app/api/events`
   - Method: POST
   - Headers: add a header named `x-checkin-key`. The value is your `CHECKIN_KEY` (from 1Password).
   - Request Body: JSON.
   - Add a field `type` (Text) and set it to `bathroom`.
3. Add **Vibrate Device** below it. That is the only feedback. Do not add Show Notification, Show Result or Show Alert: nothing may light up the room. If the request fails, Shortcuts shows its own error, and that is your signal to press again or to tell Claude in the morning.
4. Run it once from the Shortcuts app with the phone unlocked. You should feel a buzz. **That first press saves a real row**, which also starts the tracking. Check it afterwards by asking Claude "show last night's bathroom trips" (or `get_recovery`).

**Put it on the Action Button**

1. Settings → **Action Button**.
2. Swipe to **Shortcut**, tap **Choose a Shortcut**, and pick **Log Trip**.

**Test with the phone locked and the screen off**

1. Lock the phone and let the screen go dark.
2. Press and hold the Action Button. Feel for the buzz.
3. Expected: **it works with the phone locked and the screen off, and buzzes without asking to unlock** (this held on the iPhone it was built on, October 2026; test yours). Unlock it and look at what happened:
   - **Buzzed, no unlock needed:** it works. Check the trip shows up in `get_recovery` (it appears under today's `daytime` or the night's `bathroom_trips`).
   - **It asked you to unlock first, or never buzzed:** write down exactly what it said. The fallbacks, in order: (a) allow the shortcut to run when locked if iOS offers that option for it, (b) a Lock Screen control for `Log Trip`. Do not give up the buzz-only goal before trying (a).
4. A quick double press does nothing, because the Action Button needs a hold of about a second. That also protects against accidental presses. If a press ever is sent twice (a retry), the hub saves only one trip within 60 seconds.

**Sleep Focus stays on.** Focus modes don't stop a shortcut you start yourself.

**A trip you forgot or a press by mistake:** tell Claude ("I got up around 3", or "that last press was a mistake"). It reads the night first, confirms the time with you, and uses `log_event`. Nothing is ever deleted: a mistake is hidden and can be restored.

**Later:** a Wi-Fi button in the bathroom (an ESP32 board, or Flic and its hub) can use the same endpoint with its own key.
