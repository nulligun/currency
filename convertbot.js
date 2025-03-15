import { KickAuthClient } from 'kick-auth';
import { MongoClient } from 'mongodb';
import express from 'express';
import session from 'express-session';
import * as dotenv from 'dotenv';

dotenv.config();
const currencies = curs();
const uri = process.env.mongo_url;
const mongoclient = new MongoClient(uri);
const database = mongoclient.db("convertbot");
const collection = database.collection('tokens');
const cursor = collection.find({});

async function subscribe(token) {
    const response = await fetch('https://api.kick.com/public/v1/events/subscriptions', {
        method: 'POST',
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
            "events": [
                {
                    "name": "chat.message.sent",
                    "version": 1
                }
            ],
            "method": "webhook"
        })
    });

    const data = await response.json();
    console.log(data);
    return data;
}

const authclient = new KickAuthClient({
    clientId: process.env.KICK_CLIENT_ID,
    clientSecret: process.env.KICK_CLIENT_SECRET,
    redirectUri: process.env.KICK_REDIRECT_URI,
    scopes: ['user:read', 'channel:read', 'events:subscribe', 'chat:write']
});

let users = {};
// subscribe each user to the chat events
for (const user of await cursor.toArray()) {
    // if token is expired then refresh it
    if (new Date() > user.expires) {
        const tokens = await authclient.refreshToken(user.refresh_token);
        user.access_token = tokens.access_token;
        const expiry_date = new Date(new Date().getTime() + tokens.expires_in * 1000);
        await collection.updateOne({user_id: user.user_id}, {
            $set: {
                access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires: expiry_date
            }
        });
    }
    users[user.user_id] = user;
    await subscribe(user.access_token);
}

const wh = express();
wh.use(express.raw({ type: 'application/json' }));

const app = express();

async function convert(amount, fromc, toc) {
    const from = fromc.toUpperCase();
    const to = toc.toUpperCase();
    // if from does not exist in currencies then return
    if (!currencies[from]) {
        return `Unknown currency (from) ${from}`;
    }
    // if to does not exist in currencies then return
    if (!currencies[to]) {
        return `Unknown currency (to) ${to}`;
    }

    const url = `https://api.exchangerate-api.com/v4/latest/${from}`;
    console.log("Get currency: ", url);
    // do this with fetch
    //const response = await axios.get(url);
    const response = await fetch(url);
    const data = await response.json();
    const rate = parseFloat(data.rates[to]);
    //fix to 2 decimals
    const result = (amount * rate).toFixed(2);
    return `${amount} ${from} is ${result} ${to}`;
}

wh.post('/webhook', async (req, res) => {
    // get json contents
    const data = JSON.parse(req.body.toString());
    console.log(data);
    // if data.content starts with "!c "
    if (data.content.startsWith("!c ")) {
        // get the rest of the string
        const message = data.content.slice(3);
        // trim it, remove double spaces, and split into an array
        const args = message.trim().replace(/\s+/g, ' ').split(' ');

        const home_currency = users[data.broadcaster.user_id].home_currency || "USD";
        const active_currency = users[data.broadcaster.user_id].active_currency || "INR";

        let result = null;
        // if the first argument is fully numeric (allow decimals) then convert it from active currency to home currency
        // but if there is a second arg that matches a currency then convert it from active currency to that currency
        if (!isNaN(args[0])) {
            // convert from active currency to home currency
            // if there is a second arg that matches a currency then convert it from active currency to that currency
            if (args[1]) {
                result = await convert(args[0], active_currency, args[1]);
            } else {
                result = await convert(args[0], active_currency, home_currency);
            }
        } else if (args[0].startsWith('$')) {
            if (args[1]) {
                result = await convert(args[0].slice(1), 'USD', args[1]);
            } else {
                result = await convert(args[0].slice(1), 'USD', active_currency);
            }
        } else if (args[0] === 'active') {
            users[data.broadcaster.user_id].active_currency = args[1];
            await collection.updateOne({user_id: data.broadcaster.user_id}, {$set: {active_currency: args[1]}});
            result = `Active currency set to ${args[1]}`;
        } else if (args[0] === 'home') {
            users[data.broadcaster.user_id].home_currency = args[1];
            await collection.updateOne({user_id: data.broadcaster.user_id}, {$set: {home_currency: args[1]}});
            result = `Home currency set to ${args[1]}`;
        } else {
            // if the first argument is number+a valid currency code the convert from that currency to active currency
            // split the first argument into the number and currency code
            const num = parseFloat(args[0].slice(0, -3));
            const code = args[0].slice(-3);
            if (args[1]) {
                result = await convert(num, code, args[1]);
            } else {
                result = await convert(num, code, active_currency);
            }

            // if there is a second arg that matches a currency then convert it from first currency to second currency
        }

        if (result) {
            await sendMessage(result, data.broadcaster.user_id, users[data.broadcaster.user_id].access_token);
        }
    }
    res.send('ok');
});

app.use(session({
    secret: process.env.session_secret,
    resave: false,
    saveUninitialized: false
}));

app.get('/auth/kick', async (req, res) => {
    const { url, state, codeVerifier } = await authclient.getAuthorizationUrl();
    req.session.state = state;
    req.session.codeVerifier = codeVerifier;
    res.redirect(url);
});

// Protected route example
app.get('/dashboard', (req, res) => {
    if (!req.session.accessToken) {
        return res.redirect('/auth/kick');
    }
    res.send('Authenticated!');
});

async function getUser(token) {
    const response = await fetch('https://api.kick.com/public/v1/users', {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    const data = await response.json();
    return data.data;
}

async function sendMessage(message, user_id, token) {
    const response = await fetch('https://api.kick.com/public/v1/chat', {
        method: 'POST',
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
            "broadcaster_user_id": user_id,
            "content": message,
            "type": "bot"
        })
    });

    return await response.json();
}

app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;

    if (state !== req.session.state) {
        return res.status(400).send('Invalid state');
    }

    try {
        const tokens = await authclient.getAccessToken(
            code,
            req.session.codeVerifier
        );
        console.log("tokens", tokens);
        req.session.accessToken = tokens.access_token;
        req.session.refreshToken = tokens.refresh_token;

        const user = await getUser(tokens.access_token);
        await sendMessage('Convert Bot Ready!', user.user_id, tokens.access_token);
        const expiry_date = new Date(new Date().getTime() + tokens.expires_in * 1000);
        // add the document then store it in the array
        await collection.updateOne({user_id: user.user_id}, {$set: {user_id: user.user_id, name: user.name, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires: expiry_date}}, {upsert: true});
        const d = collection.findOne({user_id: user.user_id});
        users[d.user_id] = d;
        res.redirect('/dashboard');
    } catch (error) {
        console.log("error", error);
        res.status(500).send('Authentication failed');
    }
});

// Start servers
app.listen(process.env.web_port, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${process.env.web_port}`);
});

wh.listen(process.env.webhook_port, "0.0.0.0", () => {
    console.log(`WH running on http://localhost:${process.env.webhook_port}`);
});

function curs() {
    return {
        "USD": 1,
        "AED": 3.67,
        "AFN": 73.33,
        "ALL": 95.71,
        "AMD": 404.94,
        "ANG": 1.79,
        "AOA": 842.77,
        "ARS": 841.15,
        "AUD": 1.53,
        "AWG": 1.79,
        "AZN": 1.7,
        "BAM": 1.8,
        "BBD": 2,
        "BDT": 109.75,
        "BGN": 1.8,
        "BHD": 0.376,
        "BIF": 2844.37,
        "BMD": 1,
        "BND": 1.34,
        "BOB": 6.92,
        "BRL": 4.98,
        "BSD": 1,
        "BTN": 82.91,
        "BWP": 13.79,
        "BYN": 3.26,
        "BZD": 2,
        "CAD": 1.35,
        "CDF": 2734.25,
        "CHF": 0.879,
        "CLP": 987.91,
        "CNY": 7.21,
        "COP": 3947.39,
        "CRC": 514.63,
        "CUP": 24,
        "CVE": 101.66,
        "CZK": 23.35,
        "DJF": 177.72,
        "DKK": 6.88,
        "DOP": 58.75,
        "DZD": 134.41,
        "EGP": 30.9,
        "ERN": 15,
        "ETB": 56.63,
        "EUR": 0.922,
        "FJD": 2.26,
        "FKP": 0.788,
        "FOK": 6.88,
        "GBP": 0.788,
        "GEL": 2.65,
        "GGP": 0.788,
        "GHS": 12.69,
        "GIP": 0.788,
        "GMD": 66.29,
        "GNF": 8571.97,
        "GTQ": 7.81,
        "GYD": 209.15,
        "HKD": 7.82,
        "HNL": 24.68,
        "HRK": 6.95,
        "HTG": 132.78,
        "HUF": 359.88,
        "IDR": 15668.43,
        "ILS": 3.61,
        "IMP": 0.788,
        "INR": 82.91,
        "IQD": 1308.32,
        "IRR": 42063.78,
        "ISK": 137.57,
        "JEP": 0.788,
        "JMD": 156.14,
        "JOD": 0.709,
        "JPY": 150.42,
        "KES": 145.74,
        "KGS": 89.45,
        "KHR": 4098.93,
        "KID": 1.53,
        "KMF": 453.57,
        "KRW": 1331.09,
        "KWD": 0.308,
        "KYD": 0.833,
        "KZT": 449.99,
        "LAK": 20678.91,
        "LBP": 89500,
        "LKR": 310.22,
        "LRD": 192.12,
        "LSL": 19.11,
        "LYD": 4.83,
        "MAD": 10.06,
        "MDL": 17.83,
        "MGA": 4532.18,
        "MKD": 56.85,
        "MMK": 2101.75,
        "MNT": 3416.56,
        "MOP": 8.06,
        "MRU": 39.93,
        "MUR": 45.69,
        "MVR": 15.44,
        "MWK": 1691.29,
        "MXN": 17.07,
        "MYR": 4.76,
        "MZN": 63.89,
        "NAD": 19.11,
        "NGN": 1543.38,
        "NIO": 36.78,
        "NOK": 10.53,
        "NPR": 132.66,
        "NZD": 1.62,
        "OMR": 0.384,
        "PAB": 1,
        "PEN": 3.79,
        "PGK": 3.79,
        "PHP": 56.09,
        "PKR": 279.31,
        "PLN": 3.97,
        "PYG": 7299.95,
        "QAR": 3.64,
        "RON": 4.58,
        "RSD": 107.98,
        "RUB": 92.05,
        "RWF": 1292.35,
        "SAR": 3.75,
        "SBD": 8.3,
        "SCR": 13.73,
        "SDG": 449.29,
        "SEK": 10.31,
        "SGD": 1.34,
        "SHP": 0.788,
        "SLE": 22.8,
        "SLL": 22795.38,
        "SOS": 571.47,
        "SRD": 35.38,
        "SSP": 1381.1,
        "STN": 22.59,
        "SYP": 12898.75,
        "SZL": 19.11,
        "THB": 35.86,
        "TJS": 10.95,
        "TMT": 3.5,
        "TND": 3.12,
        "TOP": 2.36,
        "TRY": 31.16,
        "TTD": 6.76,
        "TVD": 1.53,
        "TWD": 31.59,
        "TZS": 2540.33,
        "UAH": 38.4,
        "UGX": 3936.33,
        "UYU": 38.88,
        "UZS": 12558.37,
        "VES": 36.07,
        "VND": 24627.74,
        "VUV": 120.34,
        "WST": 2.73,
        "XAF": 604.76,
        "XCD": 2.7,
        "XDR": 0.753,
        "XOF": 604.76,
        "XPF": 110.02,
        "YER": 250.17,
        "ZAR": 19.1,
        "ZMW": 23.16,
        "ZWL": 14293.36
    }
}