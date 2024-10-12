async function a() {
    try {
        throw new Error('abc')
    } catch(e) {
        console.log(e)

        throw e
    }
}

async function b() {
    try {
        await a()
    } catch(e) {
        console.log(e)
    }
}

(async () => {
    await b()

    console.log('after')
})()