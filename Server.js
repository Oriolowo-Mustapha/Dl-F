let isResetting = false;
function resetProvider() {
    if (isResetting) return;
    isResetting = true;
    log("CRITICAL: Unhandled provider error detected. Resetting provider in 10 seconds...");

    if (contract) {
        try {
            contract.removeAllListeners();
        } catch (e) {
            console.error("Error removing listeners:", e);
        }
    }
    provider = null;
    wallet = null;
    contract = null;

    setTimeout(() => {
        isResetting = false;
        initializeProvider();
    }, 10000);
}

process.on('uncaughtException', (error, origin) => {
    console.error('----- UNCAUGHT EXCEPTION ----- ');
    console.error('Caught exception:', error);
    console.error('Exception origin:', origin);
    console.error('------------------------------');

    // If the error is the one we're looking for, reset the provider.
    if (error.code === 'ECONNRESET') {
        resetProvider();
    }
});

import dotenv from 'dotenv';
dotenv.config({ path: 'credential.env' });
import express from 'express';
import multer from 'multer';
import axios from 'axios';
import cors from 'cors'; 
import FormData from 'form-data';
import fs from 'fs'; 
import { ethers } from 'ethers';
import { GoogleGenAI } from '@google/genai';
import path from 'path'; 
import { fileURLToPath } from 'url'; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// --- CONFIGURATION & ENV VAR CHECKS ---
const PINATA_API_KEY = 'b6242205f4820452afbd'; // Keep these hardcoded if they are part of your application logic
const PINATA_SECRET_API_KEY = '80e27d2221f00432763b56bad7e15e78fd34f116d43aee6ba90c3e9345a58187';

// Get configuration from .env file
const {
    MATCHING_ENGINE_PRIVATE_KEY,
    CONTRACT_ADDRESS, 
    FEVM_RPC_URL, 
    GEMINI_API_KEY 
} = process.env;

// Essential Environment Check
const pkLength = MATCHING_ENGINE_PRIVATE_KEY ? MATCHING_ENGINE_PRIVATE_KEY.length : 0;
if (pkLength < 64) {
    console.error(`ERROR: Private key length is ${pkLength}. It must be 64 (or 66 with '0x' prefix) characters long.`);
    throw new Error("MATCHING_ENGINE_PRIVATE_KEY not set or invalid (must be 64-character SECRET key). FIX YOUR .ENV FILE.");
}
if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set in environment variables.");
}
if (!CONTRACT_ADDRESS) {
    throw new Error("CONTRACT_ADDRESS is not set in environment variables.");
}
if (!FEVM_RPC_URL) {
    throw new Error("FEVM_RPC_URL is not set in environment variables.");
}

// --- INITIALIZATION ---
const app = express();
const port = process.env.PORT || 3000;;
const upload = multer();
const ai = new GoogleGenAI(GEMINI_API_KEY);

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

// --- FEVM Setup ---
let provider;
let wallet;
let contract;
let providerType;

const CONTRACT_ABI = [
    "function getItemCount() public view returns (uint256)",
    "function getItem(uint256 _itemId) view returns (uint256 id, address reporter, bool isLost, string memory title, string memory description, string memory ipfsCid)",
    "function matchedItem(uint256) view returns (uint256)",
    "function recordMatch(uint256 lostId, uint256 foundId) external",
    "event ItemReported(uint256 indexed itemId, address indexed reporter, bool isLost, string title, string ipfsCid)",
    "event MatchFound(uint256 indexed itemId1, uint256 indexed itemId2)"
];

function initializeProvider() {
    log("Initializing provider...");
    if (FEVM_RPC_URL.startsWith('ws') || FEVM_RPC_URL.startsWith('WSS')) {
        provider = new ethers.WebSocketProvider(FEVM_RPC_URL);
        providerType = 'WebSocket';

        // The WebSocketProvider will automatically attempt to reconnect on errors and close events.
        // We can listen for the 'error' event on the provider itself to log any issues.
        provider.on('error', (err) => {
            console.error("Ethers.js Provider Error:", err);
        });

    } else {
        provider = new ethers.JsonRpcProvider(FEVM_RPC_URL);
        providerType = 'HTTP/JSON-RPC';
    }

    wallet = new ethers.Wallet(MATCHING_ENGINE_PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    log(`Provider initialized using: ${providerType} (${FEVM_RPC_URL})`);
    log(`Engine Wallet Address: ${wallet.address}`);

    // Re-attach event listeners
    attachContractListeners();
    // Run once on startup
    runMatchingEngine();
}

function attachContractListeners() {
    if (!contract) return;
    // Start listening for new items immediately and then run on an interval
    contract.on("ItemReported", (itemId, reporter, isLost, title, ipfsCid, event) => {
        const type = isLost ? 'LOST' : 'FOUND';
        log(`NEW ITEM: ${type} ID ${Number(itemId)} reported by ${reporter}. Triggering match engine...`);
        runMatchingEngine();
    });
}

// Initial setup
initializeProvider();

// --- EXPRESS MIDDLEWARE ---
app.use(cors({ origin: '*' })); 
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// --- PINATA UPLOAD ENDPOINT ---
app.post('/api/pin-image', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    try {
        const PINATA_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
        const fileBuffer = req.file.buffer;
        const fileName = req.file.originalname;
        const mimeType = req.file.mimetype;

        const formData = new FormData();

        formData.append('file', fileBuffer, {
            filepath: fileName, 
            contentType: mimeType
        });

        const response = await axios.post(
            PINATA_URL, 
            formData, 
            {
                maxBodyLength: Infinity,
                headers: {
                    ...formData.getHeaders(),
                    'pinata_api_key': PINATA_API_KEY,
                    'pinata_secret_api_key': PINATA_SECRET_API_KEY
                }
            }
        );

        log(`Image pinned. CID: ${response.data.IpfsHash}`);
        res.status(200).json({ IpfsHash: response.data.IpfsHash });

    } catch (error) {
        console.error("Pinata Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to pin file to IPFS.' });
    }
});

// --- MANUAL TRIGGER FOR AI ENGINE ---
app.post('/api/run-engine', async (req, res) => {
    log("Manual match engine run triggered via API.");
    try {
        const txHash = await runMatchingEngine();
        if (txHash) {
            res.status(200).json({ message: `Matching engine run completed. Match transaction submitted: ${txHash}` });
        } else {
            res.status(200).json({ message: "Matching engine run completed. No new match found." });
        }
    } catch (error) {
        console.error("Error during manual engine run:", error);
        res.status(500).json({ message: "Matching engine run failed.", error: error.message });
    }
});


// --- GEMINI AI MATCHING ENGINE LOGIC ---

function createMatchingPrompt(items) {
    const lostItems = items.filter(item => item.isLost).map(item => ({
        id: item.itemId,
        title: item.title,
        description: item.description,
        type: 'LOST'
    }));

    const foundItems = items.filter(item => !item.isLost).map(item => ({
        id: item.itemId,
        title: item.title,
        description: item.description,
        type: 'FOUND'
    }));

    if (lostItems.length === 0 || foundItems.length === 0) {
        return null;
    }

    let prompt = "You are a lost and found matching service. Analyze the LOST items against the FOUND items.\n\n";
    prompt += "Your task is to find the best possible match between ONE LOST item and ONE FOUND item based on title, description, and similarity. ONLY match items that are highly likely to be the same object.\n\n";
    prompt += "LOST Items:\n";
    lostItems.forEach(item => {
        prompt += `ID: ${item.id}, Title: "${item.title}", Description: "${item.description}"\n`;
    });

    prompt += "\nFOUND Items:\n";
    foundItems.forEach(item => {
        prompt += `ID: ${item.id}, Title: "${item.title}", Description: "${item.description}"\n`;
    });

    prompt += "\nOutput ONLY the result in the exact JSON format: {\"match\": {\"lostId\": [ID_NUMBER], \"foundId\": [ID_NUMBER], \"confidence\": \"[high/medium/low]\"}} or {\"match\": null} if no match is found.";
    
    return prompt;
}

async function getGeminiMatch(prompt) {
    if (!prompt) return null;

    try {
        const systemPrompt = "Analyze the item descriptions to find a single high-confidence match between a LOST item and a FOUND item. Output ONLY the resulting JSON object.";

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        match: {
                            type: "OBJECT",
                            nullable: true,
                            properties: {
                                lostId: { type: "NUMBER" },
                                foundId: { type: "NUMBER" },
                                confidence: { type: "STRING" }
                            }
                        }
                    }
                }
            }
        };

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (jsonText) {
            const parsedJson = JSON.parse(jsonText);
            if (parsedJson.match && parsedJson.match.confidence === 'high') {
                return {
                    lostId: Number(parsedJson.match.lostId),
                    foundId: Number(parsedJson.match.foundId)
                };
            }
        }
    } catch (e) {
        console.error("Gemini API or Parsing Error:", e);
    }
    return null;
}

/**
 * Main function to run the matching engine:
 * 1. Fetch all reported items.
 * 2. Filter out already matched items.
 * 3. Send data to Gemini for matching.
 * 4. Record the match on the FEVM.
 */
async function runMatchingEngine() {
    log("--- Starting Match Engine Run ---");
    try {
        // Aggressive fix: Force re-read of .env and re-create contract object on every run.
        log("Force-reloading .env and creating fresh contract instance...");
        dotenv.config({ path: 'credential.env', override: true });
        const currentWallet = new ethers.Wallet(process.env.MATCHING_ENGINE_PRIVATE_KEY, provider);
        const currentContract = new ethers.Contract(process.env.CONTRACT_ADDRESS, CONTRACT_ABI, currentWallet);
        log(`Ensuring we are operating on contract: ${process.env.CONTRACT_ADDRESS}`);

        log("Step 1/5: Fetching item count from contract...");
        const totalItemsBN = await currentContract.getItemCount();
        const totalItems = Number(totalItemsBN);
        log(`Found ${totalItems - 1} total items.`);

        if (totalItems <= 1) {
            log("Not enough items to run matching. Exiting.");
            return null;
        }
        
        log("Step 2/5: Fetching all unmatched items...");
        const allItems = [];
        for (let id = 1; id < totalItems; id++) {
            log(`- Checking item ID ${id}...`);
            const itemData = await currentContract.getItem(id);
            const matchedIdBN = await currentContract.matchedItem(id);
            const matchedId = Number(matchedIdBN);
            
            if (matchedId === 0) {
                log(`  -> Item ${id} is unmatched. Adding to list.`);
                allItems.push({
                    itemId: Number(itemData[0]),
                    reporter: itemData[1],
                    isLost: itemData[2],
                    title: itemData[3],
                    description: itemData[4],
                    ipfsCid: itemData[5]
                });
            } else {
                log(`  -> Item ${id} is already matched. Skipping.`);
            }
        }
        log(`Found ${allItems.length} unmatched items.`);

        if (allItems.length < 2) {
            log("Not enough unique, unmatched items to run AI. Exiting.");
            return null;
        }

        log("Step 3/5: Creating prompt for Gemini AI...");
        const prompt = createMatchingPrompt(allItems);
        if (!prompt) {
            log("Could not create prompt (not enough lost/found items). Exiting.");
            return null;
        }
        log("Prompt created successfully.");

        log("Step 4/5: Sending prompt to Gemini AI for matching...");
        const match = await getGeminiMatch(prompt);
        log("Received response from Gemini.");

        if (match) {
            log(`Found HIGH CONFIDENCE match: LOST ID ${match.lostId} <-> FOUND ID ${match.foundId}`);
            log("Step 5/5: Submitting match transaction to blockchain...");
            const tx = await currentContract.recordMatch(match.lostId, match.foundId);
            log(`Submitting match transaction: ${tx.hash}`);

            tx.wait().then(receipt => {
                log(`SUCCESS: Match transaction ${receipt.hash} confirmed!`);
            }).catch(error => {
                console.error(`ERROR: Match transaction ${tx.hash} failed to confirm:`, error);
            });

            log("--- Match Engine Run Finished ---");
            return tx.hash;
        } else {
            log("No high-confidence match found in this cycle.");
            log("--- Match Engine Run Finished ---");
            return null;
        }

    } catch (error) {
        console.error("CRITICAL: Error during matching engine run:", error);
        log("--- Match Engine Run Finished with CRITICAL ERROR ---");
        throw error; // Re-throw the error so the API endpoint can catch it
    }
}

// Start listening for new items immediately and then run on an interval


let serverStarted = false;
function startServer() {
    if (serverStarted) return;
    serverStarted = true;

        // Run the engine periodically as a backup (e.g., every 5 minutes)
        log("Starting periodic match engine (runs every 5 minutes)...");
        setInterval(runMatchingEngine, 300000);
    // --- START SERVER ---
    app.listen(port, () => {
        log(`Backend server running at http://localhost:${port}`);
    });
}

// Initial setup
initializeProvider();
startServer();
