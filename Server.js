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

// --- CONFIGURATION & ENV VAR CHECKS ---
const PINATA_API_KEY = 'b6242205f4820452afbd'; // Keep these hardcoded if they are part of your application logic
const PINATA_SECRET_API_KEY = '80e27d2221f00432763b56bad7e15e78fd34f116d43aee6ba90c3e9345a58187';

// Get configuration from .env file
const {
    MATCHING_ENGINE_PRIVATE_KEY, // IMPORTANT: Must be the 64-character SECRET key!
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

// FEVM Setup
let provider;
let providerType;

if (FEVM_RPC_URL.startsWith('ws') || FEVM_RPC_URL.startsWith('WSS')) {
    provider = new ethers.WebSocketProvider(FEVM_RPC_URL);
    providerType = 'WebSocket';
} else {
    provider = new ethers.JsonRpcProvider(FEVM_RPC_URL);
    providerType = 'HTTP/JSON-RPC';
}

log(`Provider initialized using: ${providerType} (${FEVM_RPC_URL})`);

// The Wallet instantiation remains simple...
const wallet = new ethers.Wallet(MATCHING_ENGINE_PRIVATE_KEY, provider);

// Contract ABI (Combined list of needed functions)
const CONTRACT_ABI = [
    // Read functions
    "function getItemCount() public view returns (uint256)",
    "function getItem(uint256 _itemId) view returns (uint256 id, address reporter, bool isLost, string memory title, string memory description, string memory ipfsCid)",
    "function matchedItem(uint256) view returns (uint256)",
    // Write function
    "function recordMatch(uint256 lostId, uint256 foundId) external",
    // Events
    "event ItemReported(uint256 indexed itemId, address indexed reporter, bool isLost, string title, string ipfsCid)",
    "event MatchFound(uint256 indexed itemId1, uint256 indexed itemId2)"
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

// --- EXPRESS MIDDLEWARE ---
app.use(cors({ origin: '*' })); 
app.use(express.json());

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
    try {
        // The first call to a contract method will not trigger the ENS lookup.
        const totalItemsBN = await contract.getItemCount();
        const totalItems = Number(totalItemsBN);
        log(`Total items reported on chain: ${totalItems - 1}`);

        if (totalItems <= 1) {
            return;
        }
        
        // 1. Fetch all items and check match status
        const allItems = [];
        for (let id = 1; id < totalItems; id++) {
            const itemData = await contract.getItem(id);
            const matchedIdBN = await contract.matchedItem(id);
            const matchedId = Number(matchedIdBN);
            
            if (matchedId === 0) { // Only consider items that haven't been matched yet
                allItems.push({
                    itemId: Number(itemData[0]),
                    reporter: itemData[1],
                    isLost: itemData[2],
                    title: itemData[3],
                    description: itemData[4],
                    ipfsCid: itemData[5]
                });
            }
        }

        if (allItems.length < 2) {
            log("Not enough unique, unmatched items to run AI. Waiting...");
            return;
        }

        // 2. Run Gemini Matching
        const prompt = createMatchingPrompt(allItems);
        const match = await getGeminiMatch(prompt);

        // 3. Record Match on FEVM
        if (match) {
            log(`Found HIGH CONFIDENCE match: LOST ID ${match.lostId} <-> FOUND ID ${match.foundId}`);
            
            // Transaction to record the match
            const tx = await contract.recordMatch(match.lostId, match.foundId);
            log(`Submitting match transaction: ${tx.hash}`);
            await tx.wait(); // Wait for confirmation
            log("Match recorded successfully on the FEVM!");
        } else {
            log("No high-confidence match found in this cycle.");
        }

    } catch (error) {
        // We leave the robust logging here for any actual transaction errors that occur.
        console.error("CRITICAL: Error during matching engine run:", error);
    }
}

// Start listening for new items immediately and then run on an interval
contract.on("ItemReported", (itemId, reporter, isLost, title, ipfsCid, event) => {
    const type = isLost ? 'LOST' : 'FOUND';
    log(`NEW ITEM: ${type} ID ${Number(itemId)} reported by ${reporter}. Triggering match engine...`);
    runMatchingEngine();
});

// Run the engine periodically as a backup (e.g., every 5 minutes)
log("Starting periodic match engine (runs every 5 minutes)...");
setInterval(runMatchingEngine, 300000); 

// Run once on startup
runMatchingEngine();

// --- START SERVER ---
app.listen(port, () => {
    log(`Backend server running at http://localhost:${port}`);
    log(`Engine Wallet Address: ${wallet.address}`);
});
