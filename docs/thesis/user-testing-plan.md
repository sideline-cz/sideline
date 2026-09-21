# Usability Testing Plan: Sideline Platform

**Document version:** 1.0
**Date:** March 2026
**Author:** Bachelor's Thesis — Ondrej Maxa

---

## 1. Title and Objectives

### 1.1 Title

**Usability Evaluation of the Sideline Sports Team Management Platform**

### 1.2 Background

Sideline is a web-based sports team management platform that integrates with Discord to provide event scheduling, RSVP management, activity tracking, and team administration. The platform operates through two primary surfaces: a web application accessed via a browser, and a Discord bot that enables team members to interact with the system directly from within their Discord server.

### 1.3 Testing Objectives

This usability test aims to evaluate the following aspects of the Sideline platform:

1. **Task completion rate** — whether users can successfully accomplish core team management tasks without external assistance.
2. **Learnability and discoverability** — whether first-time users can navigate the web interface and Discord bot commands without prior training.
3. **Discord integration UX** — whether the transition between the web application and Discord bot interactions is intuitive and coherent.
4. **Error recovery** — whether users can identify and recover from errors unaided.
5. **Perceived usability** — the subjective satisfaction and confidence of users as measured by the System Usability Scale (SUS).

### 1.4 Research Questions

- RQ1: Can new users complete the onboarding flow (registration, team creation, member invitation) without guidance?
- RQ2: Is the Discord bot command interface sufficiently discoverable for sports team members who are familiar with Discord but not with Sideline?
- RQ3: Are the event creation and RSVP workflows on both surfaces (web and Discord) consistent and comprehensible?
- RQ4: Does the calendar subscription feature (iCal export) meet user expectations for integration with external calendar applications?

---

## 2. Target Participants

### 2.1 Sample Size and Composition

The test will be conducted with **5 to 8 participants**. This sample size is consistent with established usability research practice (Nielsen, 1994), which indicates that five participants are sufficient to uncover the majority of usability problems in a given interface.

### 2.2 Eligibility Criteria

Participants must satisfy all of the following inclusion criteria:

- Active member of a sports team (amateur or semi-professional level).
- Regular Discord user (uses Discord at minimum several times per week).
- Aged 18 or older.
- No prior exposure to the Sideline platform.
- Sufficient proficiency with web browsers and smartphone or desktop Discord clients to complete everyday tasks independently.

### 2.3 Exclusion Criteria

Participants will be excluded if they:

- Have previously tested or used the Sideline platform in any capacity.
- Are directly involved in the development or design of the platform.
- Are unable to provide informed written consent.

### 2.4 Recruitment

Participants will be recruited from an existing amateur sports team that communicates primarily via Discord. The researcher will contact the team captain and request voluntary participation. Recruitment will proceed via direct personal invitation to reduce self-selection bias.

### 2.5 Demographic Data Collected

Prior to the session, participants will be asked to complete a short background questionnaire covering:

- Age range (18–24 / 25–34 / 35–44 / 45+).
- Primary sport and team role (player / coach / administrator).
- Frequency of Discord use (daily / several times per week / weekly).
- Self-assessed digital literacy (1–5 scale).
- Whether they currently use any team management tools (e.g., TeamApp, Spond, Google Calendar).

---

## 3. Testing Methodology

### 3.1 Approach

The test employs **moderated usability testing** with a **think-aloud protocol**. Each session will be conducted individually, with the researcher present as a non-interventional observer and session facilitator. The think-aloud technique requires participants to verbalise their thoughts, intentions, and reactions continuously while completing each task, enabling the researcher to gain insight into users' mental models and points of confusion.

The researcher will not offer guidance or confirm whether actions are correct or incorrect during task execution. Clarifying questions regarding the test procedure itself (not the system) may be answered. The researcher will use standardised prompts (e.g., "What are you thinking right now?") to encourage continuous verbalisation when participants fall silent.

### 3.2 Session Format

Each usability test session will follow this structure:

| Phase | Duration |
|---|---|
| Welcome and consent signing | 5 minutes |
| Background questionnaire | 5 minutes |
| Pre-test briefing and think-aloud practice | 5 minutes |
| Task execution (13 tasks) | 45–55 minutes |
| Post-test SUS questionnaire | 5 minutes |
| Debrief interview | 10 minutes |
| **Total** | **~80 minutes** |

### 3.3 Roles

- **Facilitator (researcher):** Introduces the session, administers tasks, observes and takes notes, conducts the debrief interview.
- **Observer (optional):** A second researcher or thesis supervisor may silently observe and take supplementary notes. Observers do not interact with the participant.

### 3.4 Task Administration

Tasks will be presented to the participant one at a time, printed on individual cards or displayed on a secondary screen. The facilitator reads each task aloud before the participant begins. The participant indicates when they consider a task complete, at which point the facilitator notes the outcome and presents the next task. Participants are permitted to skip a task if they are unable to complete it after a reasonable effort; the facilitator will note the abandonment.

### 3.5 Ethical Considerations

All data collected will be anonymised. Participants will be referred to by a participant code (P1, P2, …, P8) in all analysis and reporting. Session recordings will be stored securely and deleted upon completion of thesis assessment. Participation is entirely voluntary; participants may withdraw at any time without consequence.

---

## 4. Test Environment

### 4.1 Web Application

The web application will be accessed via a **preview deployment** of the Sideline platform hosted on the staging environment. Participants will use a provided laptop or their own device (as agreed in advance). A modern web browser (Google Chrome or Mozilla Firefox, latest stable version) will be used.

### 4.2 Discord Environment

A dedicated **Discord test server** will be configured prior to each test session. The test server will have:

- The Sideline Discord bot installed and authorised.
- A text channel designated for bot interactions.
- A fresh team configuration to prevent data from previous sessions contaminating the test.

Participants will be added to the test Discord server in advance of the session or during the pre-test setup phase.

### 4.3 Required Setup (Per Session)

The following setup steps must be completed before each participant's session begins:

1. Create a fresh Sideline team linked to the test Discord server.
2. Generate an active invite code for the team.
3. Ensure the participant's Discord account is present in the test server.
4. Clear browser cache and cookies on the test device.
5. Confirm the Sideline bot is online and responding in the test server.
6. Prepare a test Discord account for the participant if they do not wish to use their personal account.
7. Verify that the iCal calendar subscription endpoint is accessible.

### 4.4 Screen and Audio Recording

Sessions will be recorded using screen capture software (e.g., OBS Studio) capturing the browser window, Discord client, and participant audio. Participants must explicitly consent to recording before the session begins.

---

## 5. Task Scenarios

Each task scenario is presented to the participant as a realistic goal-oriented situation. Implementation details (e.g., menu names, button labels) are intentionally omitted from task descriptions to avoid priming the participant and to test natural discoverability.

---

### Task A — Sign Up and Complete Profile

**Description:**
You have just been told that your team uses a platform called Sideline for team management. You need to create an account using your Discord login and fill in your profile before you can access team features.

**Steps:**
1. Navigate to the Sideline web application URL provided by the facilitator.
2. Initiate the sign-up process using the Discord OAuth button.
3. Authorise the Sideline application in the Discord OAuth consent screen.
4. Complete the profile form with a display name and any other required information.
5. Submit the profile and confirm that you have reached the main application area.

**Expected Result:**
The participant is authenticated, their profile is created, and they are directed to the post-registration state of the application (e.g., the team creation or team join screen).

**Success Criteria:**
- Participant reaches the authenticated area of the application without assistance.
- Profile is saved and visible.

---

### Task B — Create a Team and Link It to a Discord Guild

**Description:**
You are the captain of a sports team and you want to set up a new team on Sideline. You also want to connect it to your team's Discord server so that the bot can post events and announcements there.

**Steps:**
1. Locate and initiate the team creation flow.
2. Enter a team name and any other required fields.
3. Submit the team creation form.
4. Navigate to the team settings or setup area.
5. Link the team to the Discord test server provided.
6. Confirm the Discord guild is connected.

**Expected Result:**
A new team is created and the Discord guild association is established. The Discord bot becomes active in the linked server.

**Success Criteria:**
- Team is successfully created.
- Team is linked to a Discord guild without error.

---

### Task C — Invite a Teammate via Invite Code

**Description:**
You want to invite a new player to join your team on Sideline. You will share an invite link with them and they will use it to join.

**Steps:**
1. Navigate to the team members section or settings.
2. Locate the option to generate or view the team invite code or link.
3. Copy the invite link.
4. Open the invite link in a new browser tab (simulating the perspective of the invitee).
5. Confirm that the invite page is displayed and the join action is available.

**Expected Result:**
The invite link is successfully located and leads to a functional invitation page showing the correct team name.

**Success Criteria:**
- Participant locates the invite mechanism without assistance.
- Invite link opens a valid invitation page.

---

### Task D — Create a Role and Assign It to a Member

**Description:**
Your team has different roles for players — for example, goalkeeper, midfielder, or team captain. You want to create a new role called "Goalkeeper" and assign it to an existing team member.

**Steps:**
1. Navigate to the roles section of the team management interface.
2. Create a new role with the name "Goalkeeper".
3. Save the role.
4. Navigate to the team members section.
5. Select an existing member and assign the "Goalkeeper" role to them.
6. Confirm the assignment is saved.

**Expected Result:**
The "Goalkeeper" role is created and appears in the roles list. The selected member displays the assigned role in their member profile.

**Success Criteria:**
- Role is created successfully.
- Role is assigned to a member successfully.

---

### Task E — Create a Group and Assign Members

**Description:**
You want to organise your team into subgroups — for example, "First XI" and "Reserves". Create a group called "First XI" and add at least one team member to it.

**Steps:**
1. Navigate to the groups section of the team interface.
2. Create a new group with the name "First XI".
3. Add at least one existing team member to the group.
4. Save the group configuration.
5. Confirm the group appears in the groups list with the correct members.

**Expected Result:**
The group "First XI" is created with the assigned member(s) visible within it.

**Success Criteria:**
- Group is created without error.
- At least one member is successfully added to the group.

---

### Task F — Create a Single Event with RSVP

**Description:**
Your team has a training session coming up next Tuesday. You want to create an event for it on Sideline so that members can see it and respond with their attendance.

**Steps:**
1. Navigate to the events section of the team interface.
2. Initiate the event creation flow.
3. Enter an event title (e.g., "Tuesday Training"), date, start time, and location.
4. Enable RSVP functionality for the event (if presented as an option).
5. Optionally, select a Discord channel for the event announcement.
6. Save and publish the event.
7. Confirm the event appears in the event list.

**Expected Result:**
The event is created and visible in the event list. If a Discord channel was selected, an announcement message with RSVP buttons is posted to that channel by the bot.

**Success Criteria:**
- Event is created successfully.
- Event is visible in the team's event list.
- (If Discord channel was selected) Bot message with RSVP buttons appears in Discord.

---

### Task G — RSVP to an Event via Discord Bot Button

**Description:**
You have received a Discord message from the Sideline bot about an upcoming team event. You want to respond that you will be attending.

**Steps:**
1. Locate the event announcement message posted by the Sideline bot in the designated Discord channel.
2. Click the "Yes" (attending) RSVP button on the bot message.
3. Optionally, add a note in the RSVP modal that appears.
4. Submit the RSVP response.
5. Confirm that the bot acknowledges the response.

**Expected Result:**
The RSVP is recorded and the bot replies with a confirmation message. The attendee count on the event embed is updated.

**Success Criteria:**
- Participant locates and clicks the RSVP button without assistance.
- RSVP response is confirmed by the bot within a reasonable time.

---

### Task H — Create a Recurring Event Series

**Description:**
Your team has weekly training every Thursday evening. Instead of creating each event individually, you want to set up a recurring event series.

**Steps:**
1. Navigate to the events section and initiate event creation.
2. Enter the event details (title, time, location).
3. Locate and enable the recurring/repeat option.
4. Configure the recurrence to repeat weekly on Thursdays.
5. Set a reasonable end date or number of occurrences.
6. Save the recurring event series.
7. Confirm that multiple events appear in the event list corresponding to the recurrence pattern.

**Expected Result:**
Multiple events are created following the weekly Thursday pattern and are visible in the event list.

**Success Criteria:**
- Recurring event option is located and configured without assistance.
- Multiple instances of the event appear in the event list.

---

### Task I — Log an Activity via Discord Bot Command

**Description:**
You have just returned from a gym session and want to log this as a personal activity on Sideline using the Discord bot.

**Steps:**
1. Open the test Discord server.
2. Navigate to the designated bot interaction channel.
3. Use the appropriate bot command to log a gym activity (e.g., `/makanicko log`).
4. Select "gym" as the activity type when prompted.
5. Optionally, specify a duration and add a short note.
6. Submit the command and confirm the bot acknowledges the logged activity.

**Expected Result:**
The activity is logged successfully and the bot replies with a confirmation message referencing the activity type.

**Success Criteria:**
- Participant locates and uses the correct command without referring to external documentation.
- Bot confirms the activity is logged.

---

### Task J — View the Activity Leaderboard

**Description:**
Your team has been competing to see who logs the most activities each month. You want to see the current leaderboard in Discord.

**Steps:**
1. Open the test Discord server.
2. Use the appropriate bot command to display the activity leaderboard (e.g., `/makanicko leaderboard`).
3. Read the leaderboard embed returned by the bot.
4. Identify your own rank from the footer of the embed.

**Expected Result:**
The bot returns a leaderboard embed showing ranked team members by activity count. The participant's own rank is displayed in the embed footer.

**Success Criteria:**
- Participant successfully invokes the leaderboard command.
- Leaderboard data is displayed correctly.

---

### Task K — Subscribe to Calendar via iCal

**Description:**
You want to see your team's events directly in your personal calendar application (e.g., Google Calendar or Apple Calendar). You need to subscribe to the team's calendar feed.

**Steps:**
1. Navigate to the relevant section of the web application (e.g., calendar subscription or settings).
2. Locate the iCal subscription link or URL.
3. Copy the calendar subscription URL.
4. Simulate adding the URL to an external calendar application (the participant describes what they would do next, or adds it to a calendar application if available on the test device).
5. Confirm they understand what the link does and what would appear in their calendar.

**Expected Result:**
The iCal subscription URL is located and the participant can explain or demonstrate how to use it with an external calendar application.

**Success Criteria:**
- Participant locates the iCal link without assistance.
- Participant correctly understands the purpose and use of the link.

---

### Task L — Configure Team Settings

**Description:**
You want to review and update your team's configuration. Specifically, you want to change the team's name and check whether any Discord notification settings are available.

**Steps:**
1. Navigate to the team settings area.
2. Locate the option to edit the team name and update it.
3. Save the updated team name.
4. Locate and review any available notification or Discord channel configuration options.
5. Confirm the changes are saved.

**Expected Result:**
The team name is updated successfully. The participant finds and reviews the notification or Discord integration settings.

**Success Criteria:**
- Team name is updated without error.
- Participant can locate and navigate the notification/integration settings.

---

### Task M — Give a Teammate a Variable Symbol and Check Their Payment QR Code

**Description:**
Your team has just started accepting bank transfers for membership fees, and one teammate does not yet have a variable symbol (the number that identifies who a payment belongs to). You want to give them one, and then check that the payment reminder shows a scannable QR code.

**Steps:**
1. Navigate to the team's member list and find the teammate who is missing a variable symbol (they should be visibly flagged).
2. Open that member's profile and assign them a variable symbol.
3. Save the change and confirm it was accepted.
4. Navigate to your own **My Payments** page and open a fee you still owe.
5. Locate and view the payment QR code for that fee.

**Expected Result:**
The teammate's profile now shows a variable symbol. The participant can locate and open the QR code for an outstanding fee on their own My Payments page.

**Success Criteria:**
- Participant can identify which teammate is missing a variable symbol without being told directly.
- Variable symbol is saved without error.
- Participant successfully finds and opens the QR code display.

**Notes for facilitator:** This task deliberately does not involve connecting a real Fio bank account (which would require live banking credentials the participant does not have) — it exercises only the parts of the bank-sync feature that a regular participant can complete in a lab session. Connecting the account itself, the historical-import "10-minute unlock window" flow, and reviewing the matching queue are treasurer-only workflows better suited to expert review or a treasurer-specific follow-up session than to this general usability pass.

---

## 6. Data Collection Methods

### 6.1 Quantitative Measures

| Measure | Description | Collection Method |
|---|---|---|
| Task completion rate | Binary (success / failure) or partial success per task | Observer notes |
| Time on task | Duration from task start to completion or abandonment | Stopwatch / session recording timestamp |
| Error count | Number of incorrect actions or navigation dead-ends per task | Observer notes |
| SUS score | Standardised perceived usability score (0–100) | SUS questionnaire (post-test) |
| Post-task satisfaction | Subjective ease rating per task (1–5 scale) | Rating card after each task |

### 6.2 Qualitative Measures

| Measure | Description | Collection Method |
|---|---|---|
| Think-aloud verbalisations | Spontaneous comments, confusion, expectations | Session recording, observer notes |
| Debrief interview responses | Opinions, preferences, suggestions | Audio recording, researcher notes |
| Critical incidents | Moments of significant confusion, error, or frustration | Observer notes, video review |

### 6.3 Instruments

- **Task recording sheet** (see Section 11) — completed by the observer in real time.
- **Post-task rating card** — a physical or on-screen card presented after each task, asking: "How easy was this task to complete?" (1 = very difficult, 5 = very easy).
- **SUS questionnaire** (see Section 8) — administered after all tasks are complete.
- **Debrief interview guide** — a set of five to seven open-ended questions exploring overall impressions, most and least intuitive features, and suggestions for improvement.

---

## 7. Evaluation Metrics

### 7.1 Task Completion Rate

- **Target:** Greater than 80% of tasks completed successfully across all participants.
- A task is coded as **success** if the participant achieves the goal state without facilitation.
- A task is coded as **partial success** if the participant achieves the goal but required a significant number of incorrect steps, or if the goal was achieved differently than the intended flow.
- A task is coded as **failure** if the participant explicitly gives up, requests help, or the session timer expires.

### 7.2 SUS Score

- **Target:** Mean SUS score of 68 or above, which is the accepted industry benchmark for "average" usability (Bangor, Kortum, & Miller, 2008).
- A mean SUS score above 80 is considered "good" usability and above 90 is considered "excellent."

### 7.3 Time on Task

- Times will be analysed descriptively (mean, median, range per task).
- Outliers (times more than 2 standard deviations above the mean) will be flagged for qualitative investigation.
- No absolute pass/fail threshold is applied to time on task; it is used as a comparative and diagnostic measure.

### 7.4 Critical Error Threshold

- A **critical error** is defined as any error that directly prevents task completion or results in data loss (e.g., inadvertently deleting a team resource, submitting an incorrect RSVP that cannot be corrected).
- **Target:** Zero critical errors related to irreversible data loss.
- Critical errors will be enumerated per task and reported individually regardless of rate.

### 7.5 Post-Task Satisfaction

- Per-task mean satisfaction ratings below 3.0 on the 1–5 scale will be flagged as requiring design attention.

---

## 8. SUS Questionnaire

The System Usability Scale (Brooke, 1996) will be administered in full immediately after the task execution phase, before the debrief interview. Participants respond to each statement on a five-point Likert scale: **Strongly disagree (1) — Strongly agree (5)**.

---

**Participant code:** ________ **Date:** ________

For each of the following statements, please circle the number that best reflects your reaction to the Sideline platform.

| # | Statement | Strongly disagree | | | | Strongly agree |
|---|---|---|---|---|---|---|
| 1 | I think that I would like to use this system frequently. | 1 | 2 | 3 | 4 | 5 |
| 2 | I found the system unnecessarily complex. | 1 | 2 | 3 | 4 | 5 |
| 3 | I thought the system was easy to use. | 1 | 2 | 3 | 4 | 5 |
| 4 | I think that I would need the support of a technical person to be able to use this system. | 1 | 2 | 3 | 4 | 5 |
| 5 | I found the various functions in this system were well integrated. | 1 | 2 | 3 | 4 | 5 |
| 6 | I thought there was too much inconsistency in this system. | 1 | 2 | 3 | 4 | 5 |
| 7 | I would imagine that most people would learn to use this system very quickly. | 1 | 2 | 3 | 4 | 5 |
| 8 | I found the system very cumbersome to use. | 1 | 2 | 3 | 4 | 5 |
| 9 | I felt very confident using the system. | 1 | 2 | 3 | 4 | 5 |
| 10 | I needed to learn a lot of things before I could get going with this system. | 1 | 2 | 3 | 4 | 5 |

**SUS Scoring Instructions (for researcher use only):**
- For odd-numbered items (1, 3, 5, 7, 9): subtract 1 from the participant's response.
- For even-numbered items (2, 4, 6, 8, 10): subtract the participant's response from 5.
- Sum all ten adjusted scores and multiply by 2.5 to obtain the SUS score (range: 0–100).

---

## 9. Schedule

### 9.1 Overall Timeline

| Activity | Timing |
|---|---|
| Participant recruitment | 2 weeks before testing |
| Test environment setup and pilot test | 1 week before testing |
| Pilot session (single internal participant) | 3–5 days before testing |
| Usability test sessions (5–8 participants) | Testing week |
| Data analysis and SUS scoring | 1 week after testing |
| Findings report for thesis | 2 weeks after testing |

### 9.2 Individual Session Schedule

Each individual test session is structured as follows:

| Time (elapsed) | Activity |
|---|---|
| 0:00 – 0:05 | Welcome, introduce the purpose of the session, obtain signed consent |
| 0:05 – 0:10 | Administer background questionnaire |
| 0:10 – 0:15 | Explain think-aloud protocol; conduct practice task (e.g., "find the settings in a web browser") |
| 0:15 – 1:10 | Task execution (Tasks A–M, approximately 3–5 minutes per task) |
| 1:10 – 1:15 | Administer SUS questionnaire |
| 1:15 – 1:25 | Debrief interview |
| 1:25 – 1:30 | Thank participant, answer any questions about the platform, confirm data handling |

### 9.3 Pilot Test

A pilot test session will be conducted with one internal participant (e.g., a colleague or fellow student not involved in the project) prior to the main study. The pilot test serves to:

- Verify that all task scenarios are clearly worded and achievable.
- Check the test environment and recording setup.
- Calibrate time estimates for each task.
- Identify any ambiguities in the consent form, questionnaires, or debrief guide.

Adjustments to the protocol based on pilot findings will be documented before the main study begins.

---

## 10. Participant Consent

### 10.1 Consent Form Template

---

**INFORMED CONSENT FORM**

**Study title:** Usability Evaluation of the Sideline Sports Team Management Platform

**Researcher:** [Researcher name], [Institution name]

**Purpose of the study:**
You are being invited to participate in a usability study conducted as part of a bachelor's thesis research project. The purpose of this study is to evaluate the ease of use of the Sideline platform, a sports team management application. Your participation will help identify areas for improvement in the design of the system.

**What participation involves:**
You will be asked to complete a series of tasks using the Sideline platform while thinking aloud. The session will last approximately 80 minutes. Your screen, mouse movements, and voice will be recorded for later analysis.

**Voluntary participation:**
Your participation is entirely voluntary. You may withdraw at any time without penalty or consequence. You are not required to give a reason for withdrawing.

**Data handling:**
All data collected during this session will be anonymised. You will be identified only by a participant code (e.g., P1). Video and audio recordings will be stored in a password-protected folder, accessible only to the researcher and thesis supervisor. Recordings and associated data will be deleted following the completion and assessment of the thesis.

**No right or wrong answers:**
This study evaluates the system, not your abilities or knowledge. There are no right or wrong answers. If you are unable to complete a task, that is valuable information about the design of the system.

**Contact:**
If you have any questions before, during, or after the study, please contact: [researcher email address].

---

By signing below, I confirm that:

- I have read and understood the information above.
- I have had the opportunity to ask questions and have received satisfactory answers.
- I voluntarily agree to participate in this study.
- I consent to the session being recorded (screen, mouse, and audio).

**Participant name (print):** ____________________________

**Participant signature:** ____________________________

**Date:** ____________________________

**Researcher signature:** ____________________________

---

### 10.2 Data Handling Notes

- Consent forms will be stored securely (physical copy in a locked cabinet or scanned to an encrypted folder) and retained for a minimum of one year following submission of the thesis.
- No personally identifiable information will appear in the thesis or any published outputs.
- Participants' Discord usernames will not be recorded in analysis documents; only participant codes will be used.
- If a participant withdraws during the session, all data collected up to that point will be discarded immediately upon request.

---

## 11. Task Recording Sheet Template

The following template is to be completed by the facilitator or observer during each test session. One sheet is used per participant. Time is measured from the moment the facilitator finishes reading the task aloud to the moment the participant declares the task complete or abandons it.

---

**Participant code:** ________ **Session date:** ________ **Facilitator:** ________

| Task | Goal achieved? | Partial? | Time (mm:ss) | Error count | Critical error? | Observer notes | Post-task satisfaction (1–5) |
|---|---|---|---|---|---|---|---|
| A — Sign up and complete profile | Yes / No | Yes / No | | | Yes / No | | |
| B — Create team and link to Discord | Yes / No | Yes / No | | | Yes / No | | |
| C — Invite teammate via invite code | Yes / No | Yes / No | | | Yes / No | | |
| D — Create role and assign to member | Yes / No | Yes / No | | | Yes / No | | |
| E — Create group and assign members | Yes / No | Yes / No | | | Yes / No | | |
| F — Create single event with RSVP | Yes / No | Yes / No | | | Yes / No | | |
| G — RSVP via Discord bot button | Yes / No | Yes / No | | | Yes / No | | |
| H — Create recurring event series | Yes / No | Yes / No | | | Yes / No | | |
| I — Log activity via Discord bot command | Yes / No | Yes / No | | | Yes / No | | |
| J — View activity leaderboard | Yes / No | Yes / No | | | Yes / No | | |
| K — Subscribe to calendar via iCal | Yes / No | Yes / No | | | Yes / No | | |
| L — Configure team settings | Yes / No | Yes / No | | | Yes / No | | |
| M — Assign variable symbol and view payment QR | Yes / No | Yes / No | | | Yes / No | | |

**Additional session notes:**

_______________________________________________

_______________________________________________

_______________________________________________

**Notable think-aloud quotes (verbatim):**

_______________________________________________

_______________________________________________

_______________________________________________

**Critical incidents (describe each):**

_______________________________________________

_______________________________________________

---

## References

Bangor, A., Kortum, P. T., & Miller, J. T. (2008). An empirical evaluation of the System Usability Scale. *International Journal of Human-Computer Interaction, 24*(6), 574–594.

Brooke, J. (1996). SUS: A "quick and dirty" usability scale. In P. W. Jordan, B. Thomas, B. A. Weerdmeester, & I. L. McClelland (Eds.), *Usability evaluation in industry* (pp. 189–194). Taylor & Francis.

Nielsen, J. (1994). *Usability engineering*. Morgan Kaufmann.
