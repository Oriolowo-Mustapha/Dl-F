const express = require('express');
const cors = require('cors');   // <--- ADD THIS
const session = require('express-session');
require('dotenv').config({ path: './credential.env' });
const { Pool } = require('pg');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);


const app = express();
const port = 3000;

app.use(cors({
    origin: '*',
    credentials: true
}));

const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT,
});

// --- Middleware ---

// Passport.js setup
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        const user = result.rows[0];
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback'
},
async (accessToken, refreshToken, profile, done) => {
    try {
        let user = await pool.query('SELECT * FROM users WHERE google_id = $1', [profile.id]);
        if (user.rows.length === 0) {
            // New user
            user = await pool.query(
                'INSERT INTO users (google_id, name, email, picture) VALUES ($1, $2, $3, $4) RETURNING *',
                [profile.id, profile.displayName, profile.emails[0].value, profile.photos[0].value]
            );
        }
        done(null, user.rows[0]);
    } catch (err) {
        done(err, null);
    }
}));

app.use(passport.initialize());
app.use(passport.session());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'supersecretkey',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// --- Routes ---
const apiRouter = express.Router();
app.use('/api', apiRouter);

app.use(express.static('public'));

// Google OAuth routes
app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => {
        // Successful authentication, redirect to dashboard.
        res.redirect('/dashboard.html');
    });

app.post('/auth/google', async (req, res) => {
    const { idToken } = req.body;
    try {
        const ticket = await client.verifyIdToken({
            idToken: idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const googleId = payload['sub'];
        const email = payload['email'];
        const name = payload['name'];
        const picture = payload['picture'];

        let user = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
        if (user.rows.length === 0) {
            user = await pool.query(
                'INSERT INTO users (google_id, name, email, picture) VALUES ($1, $2, $3, $4) RETURNING *',
                [googleId, name, email, picture]
            );
        }
        req.login(user.rows[0], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send({ message: 'Error logging in.' });
            }
            res.status(200).send({ message: 'Signed in successfully.' });
        });
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Internal server error.' });
    }
});

const isAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) {
        next();
    } else {
        res.status(401).send({ message: 'Not authenticated.' });
    }
};

app.post('/report', isAuthenticated, async (req, res) => {
    const { title, description, ipfsCid } = req.body;
    try {
        await pool.query(
            'INSERT INTO files (user_id, cid, title, description) VALUES ($1, $2, $3, $4)',
            [req.user.id, ipfsCid, title, description]
        );
        res.status(200).send({ message: 'Item reported successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Internal server error.' });
    }
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM files WHERE user_id = $1', [req.user.id]);
        res.status(200).send(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Internal server error.' });
    }
});

app.post('/logout', (req, res) => {
    req.logout((err) => {
        if (err) {
            console.error(err);
            return res.status(500).send({ message: 'Error logging out.' });
        }
        req.session.destroy();
        res.status(200).send({ message: 'Logged out successfully.' });
    });
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});