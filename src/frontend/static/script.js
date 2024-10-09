const query = new URL(window.location.href).searchParams;

const logout = query.get("logout");
const login = query.get("login");

const logoutButton = document.querySelector('a[class="logout-button"]');
const nextUpdateTextElement = document.getElementById("nextUpdateText");
const loginButton = document.querySelector('a[class="login-button"]');
const nextUpdateDateElement = document.getElementById("nextUpdate");
const spotifyIdElement = document.getElementById("spotifyId");
const usernameElement = document.getElementById("username");
const userDataElement = document.getElementById("userData");

const nextUpdateTime = getCookie("nextUpdate");
const username = getCookie("username");
const spotifyId = getCookie("id");

if (username && spotifyId) {
	usernameElement.innerText = username;
	spotifyIdElement.innerText = spotifyId;

	loginButton.style.display = "none";
	logoutButton.style.display = "flex";
	userDataElement.style.display = "block";

    if (nextUpdateTime && Number.parseInt(nextUpdateTime)) {
        const nextUpdateDate = new Date(
            Number.parseInt(nextUpdateTime),
        ).toLocaleString();
    
        nextUpdateDateElement.innerText = nextUpdateDate;
        nextUpdateTextElement.style.display = "block";

        logoutButton.style.bottom = '60px'
    }
}

if (login) {
	const element = document.getElementById(`login-${login}`);

	if (element) element.style.display = "flex";
} else if (logout) {
	const element = document.getElementById(`logout-${logout}`);

	if (element) element.style.display = "flex";
}

const closeNotifButtons = document.querySelectorAll(
	'div[class*="notification-close"]',
);

for (const button of closeNotifButtons) {
	button.onclick = () => {
		button.parentElement.style.display = "none";
	};
}

function getCookie(cookieName) {
	const name = `${cookieName}=`;
	const decodedCookie = decodeURIComponent(document.cookie);
	const cookiesSplit = decodedCookie.split(";");

	for (let i = 0; i < cookiesSplit.length; i++) {
		let cookieData = cookiesSplit[i];

		while (cookieData.charAt(0) === " ") cookieData = cookieData.substring(1);

		if (cookieData.indexOf(name) === 0)
			return cookieData.substring(name.length, cookieData.length);
	}

	return "";
}
