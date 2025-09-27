# 🕵️ FEVM Lost & Found Matching Engine

A decentralized application backend that uses **Gemini AI** to automatically match lost items with found items reported on the Filecoin EVM (FEVM) blockchain.

-----

## 💡 The Problem We Are Solving

The process of reuniting lost items with their owners is often inefficient, relying on manual checks across fragmented platforms. When reports are filed on a public blockchain, matching is reduced to complex, time-consuming string comparisons or manual review by a central authority.

This project solves this by creating a secure, autonomous, and intelligent **matching layer** that runs off-chain but commits matches on-chain, providing a decentralized, instant, and high-confidence solution.

### Key Benefits:

  * **Decentralized Match Records:** All final matches are permanently recorded on the FEVM.
  * **High-Confidence Matching:** Leverages Gemini's large language model (LLM) for semantic analysis, matching items based on similar descriptions, colors, and locations, rather than simple keyword matches.
  * **Automation:** The matching engine runs continuously, triggered by new reports, requiring no manual intervention.

-----

## 🧠 How Our Agent Works (Gemini Integration)

Our system operates as a trusted off-chain service (the "Agent" or "Matching Engine") that monitors the FEVM smart contract for new activity.

### 1\. Data Collection

1.  **Contract Monitoring:** The agent listens for the `ItemReported` event emitted by the smart contract.
2.  **Item Fetching:** Upon triggering (or on a 5-minute interval), the agent queries the FEVM contract to retrieve all **unmatched** "LOST" and "FOUND" item details (ID, title, description).

### 2\. AI Matching (Gemini)

1.  **Prompt Construction:** The agent structures the retrieved data into a clear prompt, listing all unmatched LOST and FOUND items.
2.  **Structured JSON Request:** The prompt, along with a strict JSON Schema, is sent to the **Gemini 2.5 Flash** model.
      * The model is instructed to act as a "high-confidence lost and found matching service."
      * It analyzes the text similarity between all items.
      * It is forced to output a JSON object containing a potential match with a `lostId`, `foundId`, and a `confidence` level (`high`, `medium`, or `low`).
3.  **High-Confidence Filter:** The agent only proceeds if the match returned by Gemini is classified as **"high"** confidence.

### 3\. On-Chain Resolution

1.  **Transaction Submission:** If a high-confidence match is found, the agent uses its pre-funded wallet to sign and submit a transaction to the FEVM smart contract.
2.  **`recordMatch(lostId, foundId)`:** This function updates the contract state, permanently linking the two item IDs and preventing them from being matched again.
3.  **Event Emission:** The contract emits a `MatchFound` event, signaling the match to any front-end application.

-----

## 🚀 Instructions on How to Run the Agent

### Prerequisites

1.  **Node.js:** (v18+)
2.  **Git:** (For cloning the repository)
3.  **FEVM Testnet Wallet:** A private key for a wallet funded with tFIL (Testnet Filecoin) to pay for transaction gas.

### Setup

1.  **Clone the Repository:**

    ```bash
    git clone [YOUR_REPO_URL]
    cd fevm-lost-found-matching-engine
    ```

2.  **Install Dependencies:**

    ```bash
    npm install
    ```

3.  **Configure Environment Variables:**
    Create a file named `credential.env` in the root directory and populate it with your configuration:

    ```env
    # FEVM/Ethers Configuration
    MATCHING_ENGINE_PRIVATE_KEY="fd708665b85276f1dfe916aa6c4bba6a2346b4ba199bbd3c8020ccc77aa2de28"
    CONTRACT_ADDRESS="0x344944376d6ec39058e3883d62b851828139d247"
    FEVM_RPC_URL="wss://api.calibration.node.glif.io/ws1"

    # AI Configuration
    GEMINI_API_KEY="AIzaSyD1m313HdhwHQmhXC0EEV19slUeDdR3r6w"

    # IPFS Configuration (for /api/pin-image endpoint)
    PINATA_API_KEY="b6242205f4820452afbd" 
    PINATA_SECRET_API_KEY="80e27d2221f00432763b56bad7e15e78fd34f116d43aee6ba90c3e9345a58187"
    ```

4.  **Run the Agent:**

    ```bash
    node Server.js
    ```

    The server will start listening on port `3000`, the logging function will confirm the provider is active, and the matching engine will immediately run its first scan and begin listening for new `ItemReported` events.

-----

## 💾 CID of Generated Dataset

While the agent itself does not generate a single, static dataset in the traditional sense, its primary function is to **process item reports and images** and **pin the item images to IPFS via Pinata**.

The dataset the agent processes consists of all reported items (titles, descriptions, and CIDs) stored on the FEVM contract.

**CID Example (of an image processed by the agent):**

This CID represents a sample image of a lost item (e.g., a "Red Wallet") successfully pinned to IPFS by the `/api/pin-image` endpoint.

  * **Sample Item CID:** `QmWoWLcYSXDRP9cBrrm1EDkWvJjh76mqBBWRjRY6YPyD8u`

**Access Link:**
[https://purple-magic-beaver-183.mypinata.cloud/ipfs/QmWoWLcYSXDRP9cBrrm1EDkWvJjh76mqBBWRjRY6YPyD8u]
