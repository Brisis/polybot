import fs from 'fs';

// Helper to get current time in GMT+2
const getGMT2Date = () => {
    const now = new Date();
    return new Date(now.getTime() + 2 * 60 * 60 * 1000);
};

const getLogFileName = () => {
    const date = getGMT2Date().toISOString().split('T')[0];
    return `./logs/logs_trade_${date}.csv`;
};

export const writeToCSV = (dataArray) => {
    const fileName = getLogFileName();
    const row = dataArray.join(',') + '\n';
    
    if (!fs.existsSync(fileName)) {
        const header = "Timestamp,Slug,RealBalance,MockBalance,Position,UpPrice,DownPrice,Event\n";
        fs.writeFileSync(fileName, header);
    }
    fs.appendFileSync(fileName, row);
};

export const logger = {
    step: (msg) => console.log(`\n📋 ${msg}`),
    success: (msg) => console.log(`✅ ${msg}`),
    info: (msg) => console.log(`ℹ️  ${msg}`),
    error: (msg) => console.error(`❌ ${msg}`),
    warning: (msg) => console.warn(`⚠️  ${msg}`),
    writeToCSV: writeToCSV,

    trade: (msg, details = {}, state) => {
        const mode = details.mock ? 'MOCK TRADE' : 'REAL TRADE';
        console.log(`\n💰 [${mode}] ${msg}\n`);
        
        const time = getGMT2Date().toISOString().split('T')[1].slice(0, 8); // HH:MM:SS
        writeToCSV([
            time,
            state.currentSlug,
            state.realBalance || '0.00',
            state.mockBalance || '0.00',
            details.position || 'NONE',
            details.up || '',
            details.down || '',
            `TRADE: ${msg}`
        ]);
    },

    feed: (up, down, realBal, mockBal, slug, timeLeft, sessionProgress, position, mode, inWindow = true) => {
        const time = getGMT2Date().toISOString().split('T')[1].slice(0, 8); // HH:MM:SS
        const balInfo = mode === 'mock'
            ? `[Mock Bal: $${mockBal} | Pos: ${position || 'NONE'}]`
            : `[Real Bal: $${realBal} | Pos: ${position || 'NONE'}]`;
        const windowFlag = inWindow ? '' : '  💤 outside window';

        console.log(
            `[${time}] [${slug}] ${balInfo} | UP: $${up} | DOWN: $${down} | ` +
            `Progress: ${sessionProgress.toFixed(1)}% | Ends in: ${timeLeft}s${windowFlag}`
        );

        writeToCSV([
            time,
            slug,
            realBal || '0.00',
            mockBal || '0.00',
            position || 'NONE',
            up,
            down,
            'TICK'
        ]);
    },

    orderStatus: (orderId, status, details = {}) => {
        console.log(`📊 Order ${orderId}: ${status}`, details);
    }
};