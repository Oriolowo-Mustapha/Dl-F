const CONTRACT_ADDRESS = '0x458b5219aaab5b803706d1af739570cdcdd0fab4';
const CONTRACT_ABI = [
    // Write Functions
    "function reportLost(string memory _title, string memory _description, string memory _ipfsCid) public",
    "function reportFound(string memory _title, string memory _description, string memory _ipfsCid) public",
    
    // View Functions   
    "function getItemCount() public view returns (uint256)",
    "function getItem(uint256 _itemId) view returns (uint256 id, address reporter, bool isLost, string memory title, string memory description, string memory ipfsCid)",
    "function matchedItem(uint256) view returns (uint256)", // Getter for mapping matchedItem
    
    // Events
    "event ItemReported(uint256 indexed itemId, address indexed reporter, bool isLost, string title, string ipfsCid)",
    "event MatchFound(uint256 indexed itemId1, uint256 indexed itemId2)"
];

const BACKEND_URL = 'http://localhost:3000'; 


let provider;
let signer;
let contract;

const connectWalletButton = document.getElementById('connectWalletButton');
const walletStatus = document.getElementById('walletStatus');
const messageArea = document.getElementById('message');
const submitButton = document.getElementById('submitButton');

// 1. Wallet Connection Handler
async function connectWallet() {
    messageArea.textContent = 'Connecting...';
    if (!window.ethereum || typeof ethers === 'undefined') { 
        messageArea.textContent = 'Error: MetaMask or compatible wallet not detected, or Ethers.js failed to load.';
        return;
    }

    try {
        await window.ethereum.request({ method: 'eth_requestAccounts' });

        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();

        contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

        const address = await signer.getAddress();
        walletStatus.textContent = `Connected: ${address.substring(0, 6)}...${address.substring(38)}`;
        submitButton.disabled = false;
        messageArea.textContent = 'Wallet connected successfully. Ready to submit.';

        window.ethereum.on('accountsChanged', () => window.location.reload());
        window.ethereum.on('chainChanged', () => window.location.reload());

    } catch (error) {
        console.error("Wallet connection failed:", error);
        messageArea.textContent = 'Connection failed. Ensure you are on the Filecoin network (e.g., Calibration Testnet).';
        walletStatus.textContent = 'Wallet not connected.';
        submitButton.disabled = true;
    }
}

// 2. IPFS Upload Function (Calls secure backend)
async function pinImageToIPFS(imageFile) {
    if (!imageFile) return '';

    messageArea.textContent = '1/2: Uploading image to Filecoin/IPFS via backend...';
    
    const formData = new FormData();
    formData.append("file", imageFile);

    const res = await fetch(`${BACKEND_URL}/api/pin-image`, {
        method: "POST",
        body: formData,
    });

    if (!res.ok) {
        throw new Error(`IPFS pin failed with status: ${res.status}`);
    }

    const resData = await res.json();
    return resData.IpfsHash;
}


// 3. Smart Contract Transaction Function
async function submitLostReport() {
    const title = document.getElementById('itemTitle').value;
    const description = document.getElementById('itemDescription').value;
    const imageFile = document.getElementById('itemImage').files[0];

    if (!title || !description) {
        messageArea.textContent = 'Please provide both a title and a description.';
        return;
    }
    if (!contract) {
        messageArea.textContent = 'Error: Wallet not connected or contract not initialized.';
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Submitting...';
    messageArea.textContent = 'Processing...';

    let ipfsCid = '';

    try {
        if (imageFile) {
            ipfsCid = await pinImageToIPFS(imageFile);
            messageArea.textContent = `2/2: Image pinned (CID: ${ipfsCid}). Sending transaction to FEVM...`;
        } else {
             messageArea.textContent = `1/1: No image to pin. Sending transaction to FEVM...`;
        }
        

        const tx = await contract.reportLost(title, description, ipfsCid);
        
        const receipt = await tx.wait(); 

        messageArea.textContent = `Report successful! Tx Hash: ${receipt.hash}`;
        
        document.getElementById('itemTitle').value = '';
        document.getElementById('itemDescription').value = '';
        document.getElementById('itemImage').value = '';

    } catch (error) {
        console.error("Transaction Error:", error);
        const errorText = error.shortMessage || error.message || 'Check console for details.';
        messageArea.textContent = `Transaction failed: ${errorText}`;
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit Report (Transaction)';
    }
}


// 3. New Smart Contract Transaction Function for Found Items
async function submitFoundReport() {
    const title = document.getElementById('itemTitle').value;
    const description = document.getElementById('itemDescription').value;
    const imageFile = document.getElementById('itemImage').files[0];

    if (!title || !description) {
        messageArea.textContent = 'Please provide both a title and a description.';
        return;
    }
    if (!contract) {
        messageArea.textContent = 'Error: Wallet not connected or contract not initialized.';
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Submitting Found Item...';
    messageArea.textContent = 'Processing...';

    let ipfsCid = '';

    try {
        if (imageFile) {
            ipfsCid = await pinImageToIPFS(imageFile);
            messageArea.textContent = `2/2: Image pinned (CID: ${ipfsCid}). Sending 'Found' transaction to FEVM...`;
        } else {
            messageArea.textContent = `1/1: No image to pin. Sending 'Found' transaction to FEVM...`;
        }
        
        const tx = await contract.reportFound(title, description, ipfsCid);
        
        const receipt = await tx.wait(); 

        messageArea.textContent = `Found Item Report successful! Tx Hash: ${receipt.hash}`;
        
        document.getElementById('itemTitle').value = '';
        document.getElementById('itemDescription').value = '';
        document.getElementById('itemImage').value = '';

    } catch (error) {
        console.error("Found Item Transaction Error:", error);
        const errorText = error.shortMessage || error.message || 'Check console for details.';
        messageArea.textContent = `Transaction failed: ${errorText}`;
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit Report (Transaction)';
    }
}   

function setupSubmitHandler() {
    const pageType = document.body.getAttribute('data-page');

    let handlerFunction;

    if (pageType === 'lost') {
        handlerFunction = submitLostReport;
        submitButton.textContent = 'Submit Lost Report (Transaction)'; 
        
    } else if (pageType === 'found') {
        handlerFunction = submitFoundReport;
        submitButton.textContent = 'Submit Found Report (Transaction)';
        
    } else {
        messageArea.textContent = 'Error: Could not determine page type for submission.';
        submitButton.disabled = true;
        return;
    }
    submitButton.addEventListener('click', handlerFunction);
}

document.addEventListener('DOMContentLoaded', () => {
    connectWalletButton.addEventListener('click', connectWallet);
    
    setupSubmitHandler();

    if (window.ethereum && window.ethereum.selectedAddress) {
        connectWallet();
    }
});