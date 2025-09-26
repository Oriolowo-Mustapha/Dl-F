window.handleCredentialResponse = async (response) => {
    const idToken = response.credential;
    try {
        const res = await fetch('/auth/google', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ idToken }),
        });

        if (res.ok) {
            setTimeout(() => {
                window.location.href = '/dashboard.html';
            }, 200); 
        } else {
            alert('Google Sign-in failed.');
        }
    } catch (error) {
        console.error(error);
        alert('An error occurred during Google Sign-in.');
    }
};
document.addEventListener('DOMContentLoaded', () => {
    const baseUrl = 'http://localhost:3000';

    const signInButton = document.getElementById('signInButton');
    const itemsList = document.getElementById('itemsList');
    const submitButton = document.getElementById('submitButton');
    const submitComplaintButton = document.getElementById('submitComplaintButton');

    if (itemsList) {
        const logoutButton = document.createElement('button');
        logoutButton.textContent = 'Logout';
        logoutButton.addEventListener('click', async () => {
            await fetch(`${baseUrl}/api/logout`, { method: 'POST' });
            window.location.href = '/index.html';
        });
        document.querySelector('.container').appendChild(logoutButton);

        (async () => {
            try {
                const response = await fetch(`${baseUrl}/api/dashboard`);
                if (response.ok) {
                    const items = await response.json();
                    if (items.length === 0) {
                        itemsList.innerHTML = '<p>You have not reported any items yet.</p>';
                    } else {
                        items.forEach(item => {
                            const itemElement = document.createElement('div');
                            itemElement.classList.add('item');
                            itemElement.innerHTML = `
                                <h3>${item.title}</h3>
                                <p>${item.description}</p>
                                ${item.ipfsCid ? `<a href="https://gateway.pinata.cloud/ipfs/${item.ipfsCid}" target="_blank">View Image</a>` : ''}
                                <p>Status: ${item.status}</p>
                            `;
                            itemsList.appendChild(itemElement);
                        });
                    }
                } else {
                    window.location.href = '/index.html';
                }
            } catch (error) {
                console.error(error);
                window.location.href = '/index.html';
            }
        })();
    }

    if (submitButton) {
        submitButton.addEventListener('click', async () => {
            const title = document.getElementById('itemTitle').value;
            const description = document.getElementById('itemDescription').value;
            const imageFile = document.getElementById('itemImage').files[0];

            if (!title || !description) {
                alert('Please provide both a title and a description.');
                return;
            }

            submitButton.disabled = true;
            submitButton.textContent = 'Submitting...';

            let ipfsCid = '';

            try {
                if (imageFile) {
                    const formData = new FormData();
                    formData.append("file", imageFile);

                    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
                        method: "POST",
                        headers: {
                            pinata_api_key: '0971526a919278cf45d5',
                            pinata_secret_api_key: '8a3e484caef88d61a933126a0e1c4aa1981daf34f0b6915280037c6d227faac1',
                        },
                        body: formData,
                    });

                    const resData = await res.json();
                    ipfsCid = resData.IpfsHash;
                }

                const reportResponse = await fetch(`${baseUrl}/api/report`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ title, description, ipfsCid }),
                });

                if (reportResponse.ok) {
                    window.location.href = '/dashboard.html';
                } else {
                    alert('Failed to report item.');
                }

            } catch (error) {
                console.error(error);
                alert('An error occurred while reporting the item.');
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = 'Submit Report';
            }
        });
    }

    if (submitComplaintButton) {
        submitComplaintButton.addEventListener('click', async () => {
            const subject = document.getElementById('complaintSubject').value;
            const body = document.getElementById('complaintBody').value;

            if (!subject || !body) {
                alert('Please provide both a subject and a message.');
                return;
            }

            const response = await fetch(`${baseUrl}/api/complaint`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ subject, body }),
            });

            if (response.ok) {
                alert('Complaint submitted successfully.');
                document.getElementById('complaintSubject').value = '';
                document.getElementById('complaintBody').value = '';
            } else {
                alert('Failed to submit complaint.');
            }
        });
    }
});