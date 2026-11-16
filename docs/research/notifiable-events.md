# Notifiable events in Cadence (issue #7)

Which state changes in the code today could a Notification (in-app feed / web push) be attached to? The only source is the code at commit `0b44f31`. Paths are relative to `app/`.

**A note on terms.** `GLOSSARY.md` defines only Refund Request, Pending, Approved, Declined and Refund (`GLOSSARY.md:9-26`). It does **not** define Student, Instructor, Team Admin, Platform Admin, Seat or Enrollment. The roles below come from the code:
- `UserRole.Student | Instructor | Admin` (`db/schema.ts:11-15`). "Admin" here means the platform admin.
- `TeamMemberRole.Admin | Member` (`db/schema.ts:40-43`). "Team Admin" is the person who bought for a team.
- A Seat is a `coupons` row (`db/schema.ts:280`).
- An Enrollment is an `enrollments` row (`db/schema.ts:121`).

There is no `app/services` directory. Each mutation is a helper function inside a route module, except refund review, which lives in `lib/refund-review.server.ts`.

## Summary

| # | Event | Action → function | Actor | Should be told |
|---|---|---|---|---|
| 1 | Refund Request raised (Pending) | `routes/courses.$slug.refund.ts:89` → inline insert `:127-135` | Student | Student (an email is already built, `:137-146`); every Admin |
| 2 | Refund Request Approved + Refund recorded | `routes/admin.refund-requests.tsx:97` → `approveRefundRequest` `lib/refund-review.server.ts:40` | Admin | Student (email built `:79-93`); course Instructor |
| 3 | Refund Request Declined | same action → `declineRefundRequest` `lib/refund-review.server.ts:100` | Admin | Student (email built) |
| 4 | Enrollment removed (access lost because of an Approval) | `lib/refund-review.server.ts:74` | Admin | Student, Instructor |
| 5 | Individual purchase + Enrollment created | `routes/courses.$slug.purchase.tsx:341` → `createPurchase` `:180`, `enrollUser` `:145` | Student | Student (welcome), Instructor |
| 6 | Team purchase (team created, Seats generated) | same action `:381-387` → `createTeamPurchase` `:245` (`getOrCreateTeamForUser` `:210`, `generateCoupons` `:222`) | Team Admin | Team Admin, Instructor |
| 7 | Seat claimed + Enrollment created | `routes/redeem.$code.tsx:163` → `redeemCoupon` `:41` (update `:84`, insert `:93`) | Student | Team Admin, Student, Instructor |
| 8 | Student question (top-level comment) | `routes/courses.$slug.lessons.$lessonId.tsx:898` → `createComment` `:404` | Student | course Instructor |
| 9 | Reply to a question | lesson route `:898` with `parentId`; `routes/instructor.questions.tsx:188` → `createComment` `:118` | Instructor/Admin/Student | author of the question |
| 10 | Comment edited / deleted | lesson route `updateComment` `:437`, `deleteComment` `:459` | author or staff | author (if staff deleted it) |
| 11 | Lesson completed | lesson route `:947` → `markLessonComplete` `:218` | Student | Student (milestone); Instructor |
| 12 | Quiz submitted | lesson route `:952` → `computeResult` `:531` (insert `:603`) | Student | Student; Instructor |
| 13 | Course rated | `routes/courses.$slug.tsx:466` → `rateCourse` `:330` | Student | Instructor |
| 14 | Course status changed (Draft/Published/Archived) | `routes/instructor.$courseId.tsx:695` → `updateCourseStatus` `:154`; `routes/admin.courses.tsx:141` → `updateCourseStatus` `:76` | Instructor or Admin | Instructor (when an Admin changes it); enrolled Students (when it is Archived) |
| 15 | Course price / content changed | `routes/instructor.$courseId.tsx` `updateCoursePrice` `:176`, `createLesson` `:265`, etc. | Instructor | enrolled Students (new lesson) |
| 16 | Course created | `routes/instructor.new.tsx:112` → `createCourse` `:46` | Instructor | Admin |
| 17 | User role changed / profile edited by an Admin | `routes/admin.users.tsx:119,126` → `updateUser` `:46`, `updateUserRole` `:60` | Admin | affected user |
| 18 | Sign-up | `routes/signup.tsx:41` → insert `:78` | new Student | the Student (welcome) |

## Event details

1. **Refund Request raised.** At the point of the insert, the code has these values: `currentUserId`, `learner.{name,email}` (`:103-107`), `course.{id,title,slug}`, `eligibility.{purchaseId,amount}` (`:118`) and `reason`. The new request id is returned by `.returning()` but thrown away (`:127-135`). Nothing tells Admins. They only see the queue at `/admin/refund-requests`.
2. **Approved.** `request` is loaded by `loadForReview` and contains `learnerId`, `learnerEmail`, `learnerName`, `courseId`, `courseTitle` and `amountPaid` (`lib/refund-review.server.ts:46-48,79-93`). The admin's id is `adminUserId`. The update sets `status`, `amountRefunded`, `resolvedAt` and `resolvedByUserId` (`:61-70`). Access and the course rating are removed inside the same transaction (`:74-75`). The email is only `console.log`ged (`routes/admin.refund-requests.tsx:126-129`).
3. **Declined.** The data is the same as for Approved, plus `declineNote`, which is required (`lib/refund-review.server.ts:111-122`).
5. **Individual purchase.** Data: `userId`, `courseId`, `amountPaid` (the PPP price) and `country` (`routes/courses.$slug.purchase.tsx:362-379`). `enrollUser` is called with `sendEmail=false`, and its email branch is only a stub (`:173-175`). `purchases.createdAt` is set automatically (`db/schema.ts:225`).
6. **Team purchase.** Data: `purchase`, `team.id`, `coupons[]` with their codes, `quantity` and `totalPrice` (`:384-387`). The buyer gets no Enrollment (`:383`).
7. **Seat claimed.** Data: `coupon.{id,teamId,courseId,purchaseId}`, the `userId` of the person redeeming, and `redeemedAt` (`routes/redeem.$code.tsx:84-97`). The purchase is loaded at `:70-74`, so `purchase.userId` gives the buyer.
8. **Question asked.** Data: `userId`, `lessonId`, `parentId` (null), `body`, and the course found via `getCourseForLesson` (`:413`). Comments have `createdAt` (`db/schema.ts:344`).
9. **Reply.** The parent comment is loaded and checked (`routes/instructor.questions.tsx:140-149`), so `parent.userId` gives the person to notify. Staff access is enforced by `requireStaff` (`:209`).
11. **Lesson completed.** Sets `lessonProgress.completedAt` (`:226`). Nothing checks whether this completes the whole course.

## Gaps

- **Refund issued / failed.** The glossary says a Refund is "money returned to the learner's card" (`GLOSSARY.md:21-22`). The code has no payment call: the Refund is only `amountRefunded` written in the database (`lib/refund-review.server.ts:64`). There is no issued or failed state and no column for one (`db/schema.ts:232-256`).
- **Enrollment completed.** `enrollments.completedAt` exists (`db/schema.ts:134`) and is read (`routes/dashboard.tsx:27`), but no code ever writes it. The only `completedAt` write is to lesson progress (`routes/courses.$slug.lessons.$lessonId.tsx:226`).
- **Enrollment lapsed / expired.** There is no expiry concept. Enrollments are removed only when a Refund Request is Approved (`lib/refund-review.server.ts:74`).
- **Team invites and member management.** `routes/team.tsx` has no `action`. Seats are shared as raw codes. `teamMembers` rows are created only for the buyer as Admin (`routes/courses.$slug.purchase.tsx:215-218`), and nothing ever adds a Member. Teams have no name (`db/schema.ts:259-264`).
- **Refund window closing soon.** The window logic exists (`lib/refund-eligibility.ts:45`), but there is no scheduler or job runner to send a reminder.
- **Finding who to notify.** Approving or declining a refund is the only place that bundles the recipient (`loadForReview`). Every other event would need extra queries:
  - Admins: `users.role` (`db/schema.ts:51`).
  - Instructor: `courses.instructorId` (`db/schema.ts:73`).
  - Enrolled Students of a course.
  - The Team Admin of a Seat: through `coupons.purchaseId → purchases.userId`.
- **No notification infrastructure.** There is no notifications table, no read/unread state, no push subscriptions and no per-user preferences in the schema (`db/schema.ts`). There is also no mail transport: emails are only `console.log` calls (`routes/admin.refund-requests.tsx:126`, `routes/courses.$slug.refund.ts:144`).
- **Missing data.**
  - The id of a new Refund Request is discarded (`routes/courses.$slug.refund.ts:127-135`).
  - Course status updates do not record the previous status, so Draft→Published (a "publish" event) cannot be told apart from other changes without re-reading the row first (`routes/instructor.$courseId.tsx:154`, `routes/admin.courses.tsx:76`).
  - `users.role` changes have no timestamp (`routes/admin.users.tsx:60`).
  - Course status changes record no actor, so there is no audit of who made them.
- **Glossary gaps.** Notification, Seat, Enrollment, Team Admin, Student and Instructor are not defined in `GLOSSARY.md` and should be added before this feature is built.
