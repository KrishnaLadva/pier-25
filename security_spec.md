# Firestore Security Specification

## 1. Data Invariants
1. A `UserPublic` record at `/users/{userId}` may only be created or edited by the verified owner of `userId` (`request.auth.uid == userId`), and users cannot self-assign owner/admin roles or tamper with immutable `uid`/`createdAt`.
2. PII (`email`, `phone`, `address`) is strictly isolated in `/users/{userId}/private/info` and readable/writable only by `userId` or a verified admin. Listing `/users` or `/users/{userId}/private` is denied.
3. `/admins/{userId}` grants owner privileges and can only be written by an existing verified owner.
4. `/menuItems/{itemId}` is publicly readable (`get`, `list`) and writable only by verified owners (`isAdmin()`), including 24-hour Daily Special toggle flags, bounded promo pricing (`0..100000`), and ISO start/expiry window timestamps.
5. `/orders/{orderId}` can only be created by a verified signed-in customer with `userId == request.auth.uid`, bounded `tableNumber` (`<= 24` chars) when ordering via dine-in QR, and non-terminal initial status `'confirmed'`. Customers may only read/list their own orders (`resource.data.userId == request.auth.uid`); owners may read and update order status. Terminal orders (`'completed'`, `'cancelled'`) are locked from customer modification.
6. `/reservations/{reservationId}` can only be created by a verified user with `userId == request.auth.uid` and initial status `'confirmed'`. Customers may read/list/cancel only their own non-terminal reservations.
7. `/reviews/{reviewId}` is publicly readable; only verified users may create reviews tied to `userId == request.auth.uid` with rating `1..5`, and only the author or an owner can delete them.
8. `/eliteGuests/{guestId}` contains only non-PII leaderboard summaries (`uid`, `displayName`, `tier`, `totalLoyaltyEarned`, `loyaltyPoints`, `totalOrders`, `updatedAt`); publicly readable and writable only by verified admins (`isAdmin()`).
9. `/inventory/{itemId}` contains kitchen stock quantities, reorder thresholds, and supplier unit costs; readable and writable strictly by verified owners (`isAdmin()` / `isBootstrappedOwner()`).
10. `/tableSessions/{tableId}` tracks active Pier 25 table check-ins (from QR scanner or dine-in ordering); readable/listable only by verified owners (`isAdmin()`) or the checked-in guest (`userId == request.auth.uid`), creatable/updatable only by verified users for their own session (`userId == request.auth.uid`) or owners, and deletable (released) strictly by verified owners.

## 2. Dirty Dozen Adversarial Payloads
1. **Shadow Role Escalation**: Creating `/users/u1` with an extra field `{ role: "owner" }` or `{ isAdmin: true }` -> Rejected by `keys().hasOnly(...)`.
2. **PII Cross-Read**: Signed-in user `u2` reading `/users/u1/private/info` -> `PERMISSION_DENIED`.
3. **Admin Collection Poisoning**: Non-owner `u2` writing `/admins/u2` -> `PERMISSION_DENIED`.
4. **Unverified Email Spoofing**: Token with `email: "krishnaladva25@gmail.com"` and `email_verified: false` -> `PERMISSION_DENIED`.
5. **Order Identity Spoofing**: User `u2` creating `/orders/o1` with `userId: "u1"` -> `PERMISSION_DENIED`.
6. **Order Price/Status Tampering**: User `u1` updating `/orders/o1` `total` or `paymentStatus` -> Rejected by `affectedKeys().hasOnly(...)`.
7. **Terminal Order Reopening**: User `u1` updating an order whose `status` is `'completed'` or `'cancelled'` -> `PERMISSION_DENIED`.
8. **Menu Hijack**: Customer `u1` creating or editing `/menuItems/m1` -> `PERMISSION_DENIED`.
9. **ID Length Poisoning**: Creating `/orders/<200-char-id>` -> Rejected by `isValidId()`.
10. **String Resource Exhaustion**: Review comment > 500 chars -> Rejected by `.size() <= 500`.
11. **Timestamp Forgery**: Creating `/orders/o1` with a backdated `createdAt` not equal to `request.time` -> `PERMISSION_DENIED`.
12. **Blanket List Scraping**: User `u2` listing `/orders` without `userId == u2` -> `PERMISSION_DENIED`.
13. **Leaderboard Points Spoofing**: Customer `u1` writing `{ totalLoyaltyEarned: 99999 }` to `/eliteGuests/u1` -> `PERMISSION_DENIED`.
14. **Inventory Exfiltration / Sabotage**: Non-owner `u1` reading or lowering `reorderLevel` on `/inventory/inv-paneer` -> `PERMISSION_DENIED`.
15. **Table Session Hijack / Guest PII Scrape**: Unauthenticated user or `u2` listing `/tableSessions` or releasing `/tableSessions/table-05` checked in by `u1` -> `PERMISSION_DENIED`.
