# Classroom Book Recommendations

A personalized book recommendation system for classrooms. Teachers manage a book catalog and students; students take a preferences questionnaire and receive teacher-curated recommendations matched to their tastes.

Built with **vanilla HTML, CSS, and JavaScript** — no frameworks, no build step. Runs on a lightweight Node.js server with JSON file storage.

## Features

### For Students
- **Unique Code Login** — each student gets a unique code (like `READ-7X2K`) instead of a name-based login
- **Preferences Questionnaire** — answer questions about favorite genres, themes, mood, book length, and more
- **Personalized Recommendations** — books are scored and ranked based on questionnaire answers
- **Book Catalog** — browse the full collection with search and genre filters

### For Teachers
- **Teacher Account** — admin dashboard to manage everything
- **Book Database** — add, edit, and delete books with genres, themes, mood, difficulty, and cover images
- **Teacher Picks** — highlight recommended books with a ⭐ badge and recommendation boost
- **Student Management** — add students individually or in bulk, view and print unique codes
- **Questionnaire Responses** — see how students answered their preference questions
- **Recommendation Overview** — view what each student is matched with

## Quick Start

You only need **Node.js** installed. No database, no build step.

```bash
node server.js
```

Open **http://localhost:8080** and sign in:

| Role | Login | Password |
|------|-------|----------|
| Teacher (Admin) | username: `admin` | `admin123` |
| Student | unique code (e.g. after adding in admin) | default password |

## How It Works

1. **Teacher signs in** and adds books to the catalog (with genres, themes, mood, difficulty)
2. **Teacher adds students** — each gets a unique code like `READ-7X2K`
3. **Students sign in** with their code and take the preferences questionnaire
4. **Recommendations are generated** by matching questionnaire answers to book metadata
5. **Teacher picks** (⭐) get a bonus score, surfacing teacher-curated favorites

## Architecture

Same setup pattern as [classroomlib](https://github.com/mob5824m-wq/classroomlib):

```
├── server.js           # Node.js HTTP server (no dependencies)
├── bookrecs-data.json  # Shared data store (auto-created)
├── index.html          # Home page
├── login.html          # Student code + admin login
├── catalog.html        # Book catalog with search/filter
├── questionnaire.html  # Preferences questionnaire
├── recommendations.html # Personalized recommendations
├── admin.html          # Teacher dashboard
├── css/style.css       # Main stylesheet
├── js/app.js           # Shared client-side utilities
├── sw.js               # Service worker (PWA offline)
└── manifest.webmanifest
```

### Security Model
- **Admin passwords** are scrypt-hashed (one-way, never recoverable)
- **Student passwords** are AES-256-GCM encrypted at rest (recoverable by admin)
- **Sessions** use secure httpOnly cookies with 6-hour inactivity timeout
- **Non-admin users** cannot modify the book catalog or user accounts via the API

## Questionnaire Questions

The system asks students about:

1. **Genres** they enjoy (multi-select: Fantasy, Sci-Fi, Mystery, etc.)
2. **Reading level** preference (Easy, Just right, Challenging)
3. **Book length** preference (Short, Medium, Long, No preference)
4. **Mood** they're looking for (Light and fun, Dark and intense, etc.)
5. **Themes** that interest them (Friendship, Family, Identity, etc.)
6. A **favorite book** they've loved (optional, free text)
7. A **favorite movie/show** they've enjoyed (optional, free text)

## License

MIT
