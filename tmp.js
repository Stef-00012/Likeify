const axios = require('axios');

(async () => {
    try {
        await axios.get('https://discord.com/api/v10/users/me')
    } catch(e) {
        console.log(e.response.headers.get('content-length'))
    }
})()