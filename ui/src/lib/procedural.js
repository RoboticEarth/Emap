export const ProceduralLib = {
    // 1. Math Helpers
    lerp: (a, b, t) => a + t * (b - a),
    smoothstep: (t) => t * t * (3 - 2 * t),
    fade: (t) => t * t * t * (t * (t * 6 - 15) + 10),
    
    grad3: [
        [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
        [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
        [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
    ],
    
    p: new Uint8Array([151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180,151]),

    init() {
        if (this.perm) return;
        this.perm = new Uint8Array(512);
        for(let i=0; i<512; i++) this.perm[i] = this.p[i & 255];
    },

    dot(g, x, y) { return g[0]*x + g[1]*y; },

    noise2D(x, y) {
        this.init();
        
        let X = Math.floor(x) & 255;
        let Y = Math.floor(y) & 255;
        
        x -= Math.floor(x);
        y -= Math.floor(y);
        
        let u = this.fade(x);
        let v = this.fade(y);
        
        let A = this.perm[X]+Y, AA = this.perm[A], AB = this.perm[A+1];
        let B = this.perm[X+1]+Y, BA = this.perm[B], BB = this.perm[B+1];
        
        return this.lerp(
            this.lerp(this.dot(this.grad3[AA % 12], x, y), this.dot(this.grad3[BA % 12], x-1, y), u),
            this.lerp(this.dot(this.grad3[AB % 12], x, y-1), this.dot(this.grad3[BB % 12], x-1, y-1), u),
            v
        );
    },

    voronoi(x, y, type = 'euclidean') {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        
        let minDist = 100;
        let cellId = 0;

        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                const neighborX = xi + i;
                const neighborY = yi + j;
                
                const n = (neighborX & 255) * 31 + (neighborY & 255) * 13;
                let t = (n << 13) ^ n;
                const randVal = (1.0 - ((t * (t * t * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0);
                const randVal2 = (1.0 - (((t+1) * ((t+1) * (t+1) * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0);

                const pointX = neighborX + 0.5 + 0.5 * Math.sin(randVal * 6.28);
                const pointY = neighborY + 0.5 + 0.5 * Math.cos(randVal2 * 6.28);

                let dist;
                const dx = x - pointX;
                const dy = y - pointY;

                if (type === 'manhattan') dist = Math.abs(dx) + Math.abs(dy);
                else if (type === 'chebychev') dist = Math.max(Math.abs(dx), Math.abs(dy));
                else dist = Math.sqrt(dx*dx + dy*dy); 

                if (dist < minDist) {
                    minDist = dist;
                    cellId = randVal;
                }
            }
        }
        return { distance: minDist, id: cellId };
    },

    fbm(x, y, octaves, lacunarity = 2, gain = 0.5, type = 'standard') {
        let total = 0;
        let amplitude = 0.5;
        let frequency = 1;
        let maxValue = 0;

        for (let i = 0; i < octaves; i++) {
            let n = this.noise2D(x * frequency, y * frequency);
            
            if (type === 'turbulence') {
                n = Math.abs(n);
            } else if (type === 'ridge') {
                n = 1.0 - Math.abs(n);
                n = n * n;
            } else {
                n = (n + 1) / 2;
            }

            total += n * amplitude;
            maxValue += amplitude;
            amplitude *= gain;
            frequency *= lacunarity;
        }
        
        return total / maxValue;
    },

    warp(x, y, amount) {
        const qx = this.fbm(x, y, 2);
        const qy = this.fbm(x + 5.2, y + 1.3, 2);
        return { x: x + amount * qx, y: y + amount * qy };
    }
};