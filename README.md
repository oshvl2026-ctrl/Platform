# CourseHub: your own course platform

Build courses, sell them online and teach students, all on a site you own.

**What it does**

- **Storefront**: course pages with a lesson list, free preview lessons, bundles and coupon codes.
- **Payments**: Paymob for local payments in EGP (cards, mobile wallets and other methods on your Paymob account), and Stripe for international cards in USD. Each course has a price in each currency. A coupon can take a percentage off, a fixed amount off, or 100% off to make a course free.
- **Lessons**:
  - video: a YouTube, Vimeo, Loom or Bunny link, or an uploaded MP4 file
  - PDF, Word, PowerPoint and Excel files, shown page by page in the browser on any phone or computer
  - reading lessons
  - quizzes with a pass mark
- **Students**: accounts, progress tracking, "continue where you left off", password reset by email, and a purchase history.
- **Certificates**: issued automatically when a student finishes every lesson. Each one has an ID that anyone can check at `/verify`. Arabic names print correctly.
- **Admin area**: sales dashboard, course builder, students (give or remove access, reset passwords, export to CSV), orders, coupons and bundles.

---

## Put it online (about 30 minutes, no coding)

You'll use **GitHub** to store the code and **Railway** to run the site. Railway's Hobby plan costs $5 a month plus a small charge for storage, about $0.15 per GB per month.

### Step 1: Put the code on GitHub
1. Create a free account at **github.com**.
2. Click **+** (top right), then **New repository**. Name it `coursehub`, choose **Private**, and click **Create repository**.
3. On the next page, click **uploading an existing file**.
4. Unzip `coursehub.zip` on your computer. Open the `coursehub` folder, select **everything inside it** and drag it onto the GitHub page.
5. Click **Commit changes**.

### Step 2: Create the site on Railway
1. Go to **railway.com** and sign up with your GitHub account. Choose the **Hobby** plan.
2. Click **New Project**, then **Deploy from GitHub repo**, and pick `coursehub`. Railway starts building it. The first build takes about 5 minutes.
3. **Add storage**, so your courses and students are kept safe:
   1. Open the service.
   2. Right-click on the canvas (or press ⌘K / Ctrl+K) and choose **Add Volume**.
   3. Attach it to the coursehub service with the **mount path** `/data`.
4. **Get your web address**: open the service and go to **Settings**, then **Networking**, then **Generate Domain**. Copy the address, for example `https://coursehub-production.up.railway.app`.

### Step 3: Add your settings
In the service, open **Variables** and click **Raw Editor**. Paste the block below and change the values:

```
BASE_URL=https://coursehub-production.up.railway.app
SITE_NAME=Your School Name
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=a-long-password-you-will-remember
SESSION_SECRET=type-any-long-random-text-here-at-least-40-characters
DATA_DIR=/data
BRAND_COLOR=#0E6B5C
```

Click **Update Variables**. Railway restarts the site. Then open your address, click **Log in** and use your admin email and password.

> To use your own domain (like `learn.yourschool.com`), add it under **Settings**, then **Networking**, then **Custom Domain**. Follow the DNS instructions there, then update `BASE_URL` to match.

### Step 4: Turn on Paymob (local payments)
1. In your Paymob dashboard, open **Settings**, then **Account Info**, and copy your **Secret Key**, **Public Key** and **HMAC**.
2. Open **Developers**, then **Payment Integrations**, and note the **Integration ID** of each payment method you want to offer (for example card and mobile wallet).
3. For each integration, set:
   - **Transaction processed callback**: `https://YOUR-ADDRESS/webhooks/paymob`
   - **Transaction response callback**: `https://YOUR-ADDRESS/checkout/paymob/return`
4. Add these variables in Railway:
   ```
   PAYMOB_SECRET_KEY=...
   PAYMOB_PUBLIC_KEY=...
   PAYMOB_HMAC_SECRET=...
   PAYMOB_INTEGRATION_IDS=1234567,7654321
   ```
   Use your **test** keys and test integration IDs first. Buy a course with Paymob's test card, then switch to the live values.

### Step 5: Turn on Stripe (international cards). Optional.
Stripe does not open accounts for businesses based in Egypt. You need a company in a country Stripe supports, for example a US company set up through Stripe Atlas. If you don't have one, skip this step: the card option simply won't show. Paymob card payments also accept international Visa and Mastercard.

If you do have Stripe:
1. In the Stripe dashboard, go to **Developers**, then **API keys**, and copy the **Secret key**.
2. Go to **Developers**, then **Webhooks**, and click **Add endpoint**:
   - URL: `https://YOUR-ADDRESS/webhooks/stripe`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
   - After saving, copy the **Signing secret** (it starts with `whsec_`).
3. Add these variables in Railway:
   ```
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

### Step 6: Turn on email (recommended)
Email lets students reset their password and get a receipt. Any email provider works. With Gmail, create an **App password** (Google Account, then Security, then App passwords) and add:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-16-character-app-password
SMTP_FROM=Your School <you@gmail.com>
```
For more than a few hundred emails a day, use a sending service such as Brevo, Mailgun or Amazon SES. They provide the same five settings.

---

## Building your first course
1. Go to **Admin**, then **Courses**, then **New course**. Add a title, a short description, the page text, both prices and a cover image.
2. On the course page, add **sections** such as "Week 1", and add **lessons** inside each one:
   - **Video**: paste a video link (best for long videos) or upload an MP4.
   - **Document**: upload a PDF, Word, PowerPoint or Excel file. Students see the pages in the browser. Untick **Let students download** to show the file without offering the download.
   - **Reading**: write the lesson text. You can also attach a file.
   - **Quiz**: set a pass mark and add multiple-choice questions.
3. Tick **Free preview** on one or two lessons so visitors can try before buying.
4. Tick **Published** on the course when it's ready.

**Where to keep videos:** uploading MP4s works, but large video files use up storage and bandwidth on Railway. For long courses, host videos on **Bunny Stream** (cheap, with domain protection), **Vimeo**, or an **unlisted YouTube** video, and paste the link into the lesson.

**Coupons:** go to **Admin**, then **Coupons**. Examples are `LAUNCH20` for 20% off, or a 100% code to give free access. A coupon can be limited to one course, a set number of uses, or an end date.

**Giving access by hand:** go to **Admin**, then **Students**, open a student, and click **Give free access**. This works for bank transfers, gifts or corporate clients.

---

## Backups
Everything (the database, uploads and certificates) lives in the Railway volume at `/data`. Enable backups on the volume (open the volume, then **Backups**). Also download a copy now and then with the Railway CLI or from the volume's file browser.

## Running it on your own computer (optional)
You need Node.js 20 or newer, and LibreOffice if you want Word and PowerPoint previews.
```
npm install
cp .env.example .env     # then edit .env
npm start                # open http://localhost:3000
```

## Settings reference
Every setting is listed with an explanation in `.env.example`.

## Security notes
- Payments are confirmed only by signed messages from Stripe and Paymob. Messages with a bad signature or a changed amount are rejected.
- Videos and documents are served only to enrolled students and admins. Free-preview lessons are open to everyone.
- Passwords are stored hashed. Login attempts are rate-limited, and every form is protected against cross-site request forgery.
