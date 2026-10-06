# Reloved Marketplace (PWA)

A installable marketplace web app: browse, sell, chat, offers, checkout, orders, reviews, seller tools.
Static files only (no build step) plus a Supabase backend for shared data and sign-in.

## 1. Create the backend (about 5 minutes)

1. Create a free project at supabase.com.
2. SQL Editor > New query > paste all of `supabase/schema.sql` > Run. This creates the table, security rules, live updates and sample items.
3. Authentication > Providers > Email: for testing, turn off "Confirm email" so new accounts can sign in at once.
4. Project Settings > API: copy the Project URL and the `anon` public key into `config.js`.

## 2. Run it locally

    npx serve .

Open the address it prints. Create an account, pick a username, and you are in.

## 3. Put it online

Drag this folder onto netlify.com/drop, or push it to GitHub and import it in Vercel or Cloudflare Pages. It needs HTTPS to install as an app (all three give you that).
In Supabase > Authentication > URL Configuration, add your site address as the Site URL.

## 4. Install on a phone

- Android (Chrome): menu > Install app, or Profile > Settings > Install app.
- iPhone (Safari): Share > Add to Home Screen.

## What is simulated

Payments, wallet and payouts are simulated; no money moves. Message translation is removed (it relied on Claude).

## Before real users

- Security rules are permissive: any signed-in member can edit any shared record. Tighten them with per-collection policies or server functions (orders, balances and reviews especially).
- Photos are stored inside item records as small JPEGs. Move them to Supabase Storage before you have many listings.
- Real payments need a provider such as Stripe Connect, plus seller identity checks and marketplace legal and tax setup.
