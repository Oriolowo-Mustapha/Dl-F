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

const dotenv = require('dotenv');
dotenv.config({ path: 'credential.env' });
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors'); 
const FormData = require('form-data');
const fs = require('fs'); 
const path = require('path');
const { ethers } = require('ethers');
const { GoogleGenAI } = require('@google/genai');



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

const publicPath = path.join(__dirname, '..', 'public');

app.use(express.static(publicPath));

app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

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

function createSingleMatchPrompt(lostItem, foundItems) {
    let prompt = `You are a lost and found matching service. Your goal is to determine if a single LOST item matches any of the FOUND items in the provided list. A match should only be confirmed if there is a very high degree of confidence that the items are identical.\n\n`;
    prompt += `Analyze the following items based on their title, description, and, most importantly, their images. The visual similarity between the images is the strongest indicator of a match.\n\n`;
    prompt += `--- LOST ITEM ---\n`;
    prompt += `ID: ${lostItem.itemId}\nTitle: "${lostItem.title}"\nDescription: "${lostItem.description}"\nImage CID: ${lostItem.ipfsCid}\n`;

    prompt += `\n--- FOUND ITEMS ---\n`;
    foundItems.forEach(item => {
        prompt += `ID: ${item.itemId}\nTitle: "${item.title}"\nDescription: "${item.description}"\nImage CID: ${item.ipfsCid}\n---\n`;
    });

    prompt += `\n--- INSTRUCTIONS ---\n`;
    prompt += `Compare the LOST item to each FOUND item. If you find a match with a confidence level of 95% or higher, output the result in the following JSON format: {"match": {"lostId": ${lostItem.itemId}, "foundId": [ID_OF_THE_MATCHING_FOUND_ITEM]}}.`;
    prompt += ` If no item meets this high-confidence threshold, output {"match": null}.`;
    
    return prompt;
}

async function getGeminiMatch(prompt, lostItem, foundItems) { 
    if (!prompt) return null;

    // Helper to fetch image from IPFS and convert to generative part
    async function image_to_generative_part(ipfsCid, mimeType) {
        const imageUrl = `https://gateway.pinata.cloud/ipfs/${ipfsCid}`;
        try {
            const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const base64 = Buffer.from(response.data, 'binary').toString('base64');
            return { inlineData: { mimeType, data: base64 } };
        } catch (error) {
            console.error(`Failed to fetch or process image from ${imageUrl}:`, error);
            return null; // Return null if image fetching fails
        }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    try {
        // --- 1. Construct the multi-modal prompt ---
        const lostItemImagePart = await image_to_generative_part(lostItem.ipfsCid, 'image/jpeg'); // Assuming jpeg, adjust if needed

        // Base parts array with the main text prompt and the lost item's image
        const parts = [
            { text: prompt },
            lostItemImagePart,
        ];

        // Add found items' images and descriptions
        for (const item of foundItems) {
            const foundItemImagePart = await image_to_generative_part(item.ipfsCid, 'image/jpeg');
            if (foundItemImagePart) {
                parts.push({ text: `\n\n--- Next Found Item ---\nID: ${item.itemId}, Title: "${item.title}"` });
                parts.push(foundItemImagePart);
            }
        }

        // Filter out any null image parts
        const finalParts = parts.filter(part => part !== null);

        const systemPrompt = "Analyze the item descriptions and images to find a single high-confidence match between the one LOST item and the list of FOUND items. The visual similarity of the images is the most important factor. Output ONLY the resulting JSON object.";

        const payload = {
            contents: [{ parts: finalParts }], // Use the combined text and image parts
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
                                foundId: { type: "NUMBER" }
                            }
                        }
                    }
                }
            }
        };

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        
        const result = await response.json();
        const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (jsonText) {
            const parsedJson = JSON.parse(jsonText);
            if (parsedJson.match && parsedJson.match.foundId) {
                return {
                    lostId: Number(lostItem.itemId), 
                    foundId: Number(parsedJson.match.foundId)
                };
            }
        }
    } catch (e) {
        console.error("Gemini API or Parsing Error:", e);
    } finally {
        clearTimeout(timeoutId);
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
    log("--- Starting Match Engine Run (New Simplified Logic) ---");
    try {
        log("Force-reloading .env and creating fresh contract instance...");
        dotenv.config({ path: 'credential.env', override: true });
        const currentWallet = new ethers.Wallet(process.env.MATCHING_ENGINE_PRIVATE_KEY, provider);
        const currentContract = new ethers.Contract(process.env.CONTRACT_ADDRESS, CONTRACT_ABI, currentWallet);
        log(`Ensuring we are operating on contract: ${process.env.CONTRACT_ADDRESS}`);

        log("Step 1/3: Fetching all items from contract...");
        const totalItemsBN = await currentContract.getItemCount();
        const totalItems = Number(totalItemsBN);
        log(`Found ${totalItems - 1} total items.`);

        if (totalItems <= 1) {
            log("Not enough items to run matching. Exiting.");
            return null;
        }
        
        log("Step 2/3: Sorting items into Lost, Found, and Matched...");
        const allItems = [];
        for (let id = 1; id < totalItems; id++) {
            const itemData = await currentContract.getItem(id);
            const matchedIdBN = await currentContract.matchedItem(id);
            allItems.push({
                itemId: Number(itemData[0]),
                isLost: itemData[2],
                title: itemData[3],
                description: itemData[4],
                ipfsCid: itemData[5], // Include the IPFS CID
                matchedId: Number(matchedIdBN)
            });
        }

        const unmatchedLostItems = allItems.filter(item => item.isLost && item.matchedId === 0);
        const unmatchedFoundItems = allItems.filter(item => !item.isLost && item.matchedId === 0);

        if (unmatchedLostItems.length === 0 || unmatchedFoundItems.length === 0) {
            log("No unmatched items of both types to compare. Exiting.");
            return null;
        }

        log(`Found ${unmatchedLostItems.length} unmatched lost items and ${unmatchedFoundItems.length} unmatched found items.`);
        log("Step 3/3: Iterating through lost items to find a match...");

        for (const lostItem of unmatchedLostItems) {
            log(`- Searching for a match for LOST item ID: ${lostItem.itemId} ("${lostItem.title}")`);
            const prompt = createSingleMatchPrompt(lostItem, unmatchedFoundItems);
            const match = await getGeminiMatch(prompt, lostItem, unmatchedFoundItems);

            if (match) {
                log(`  -> SUCCESS: AI found a high-confidence match! Lost ID ${match.lostId} <-> Found ID ${match.foundId}`);
                log("  -> Submitting match transaction to blockchain...");
                
                const tx = await currentContract.recordMatch(match.lostId, match.foundId);
                log(`    - Submitted match transaction: ${tx.hash}`);

                tx.wait().then(receipt => {
                    log(`    - SUCCESS: Match transaction ${receipt.hash} confirmed!`);
                }).catch(error => {
                    console.error(`    - ERROR: Match transaction ${tx.hash} failed to confirm:`, error);
                });

                log("--- Match Engine Run Finished (Match Found) ---");
                return tx.hash; // Exit after finding and submitting the first match.
            } else {
                log(`  -> No match found for item ${lostItem.itemId}. Moving to next item.`);
            }
        }

        log("--- Match Engine Run Finished (No New Matches Found) ---");
        return null;

    } catch (error) {
        console.error("CRITICAL: Error during matching engine run:", error);
        log("--- Match Engine Run Finished with CRITICAL ERROR ---");
        throw error;
    }
}

// Start listening for new items immediately and then run on an interval
initializeProvider();

// Run the engine periodically as a backup (e.g., every 5 minutes)
log("Starting periodic match engine (runs every 5 minutes)...");
setInterval(runMatchingEngine, 300000);

// --- START SERVER ---
app.listen(port, () => {
    log(`Backend server running at http://localhost:${port}`);
});

