export const solveHomography = (src, dst) => {
    let a = [], b = [];
    for (let i = 0; i < 4; i++) {
        let x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
        a.push([x, y, 1, 0, 0, 0, -x*u, -y*u]);
        a.push([0, 0, 0, x, y, 1, -x*v, -y*v]);
        b.push(u); b.push(v);
    }
    const n = 8;
    for (let i = 0; i < n; i++) {
        let maxEl = Math.abs(a[i][i]), maxRow = i;
        for (let k = i + 1; k < n; k++) if (Math.abs(a[k][i]) > maxEl) { maxEl = Math.abs(a[k][i]); maxRow = k; }
        for (let k = i; k < n; k++) { let tmp = a[maxRow][k]; a[maxRow][k] = a[i][k]; a[i][k] = tmp; }
        let tmp = b[maxRow]; b[maxRow] = b[i]; b[i] = tmp;
        for (let k = i + 1; k < n; k++) {
            let c = -a[k][i] / a[i][i];
            for (let j = i; j < n; j++) { if (i === j) a[k][j] = 0; else a[k][j] += c * a[i][j]; }
            b[k] += c * b[i];
        }
    }
    let x = new Array(n).fill(0);
    for (let i = n - 1; i > -1; i--) {
        let sum = 0;
        for (let j = i + 1; j < n; j++) sum += a[i][j] * x[j];
        x[i] = (b[i] - sum) / a[i][i];
    }
    return [[x[0], x[1], x[2]], [x[3], x[4], x[5]], [x[6], x[7], 1]];
};

export const applyHomography = (H, x, y) => {
    const w = H[2][0] * x + H[2][1] * y + H[2][2];
    const tx = (H[0][0] * x + H[0][1] * y + H[0][2]) / w;
    const ty = (H[1][0] * x + H[1][1] * y + H[1][2]) / w;
    return { x: tx, y: ty };
};

export const getCssMatrix = (dstPoints, width, height) => {
     const src = [{x:0, y:0}, {x:width, y:0}, {x:width, y:height}, {x:0, y:height}];
     const H = solveHomography(src, dstPoints);
     const m = H;
     return `matrix3d(${m[0][0]}, ${m[1][0]}, 0, ${m[2][0]},${m[0][1]}, ${m[1][1]}, 0, ${m[2][1]},0, 0, 1, 0,${m[0][2]}, ${m[1][2]}, 0, ${m[2][2]})`;
};

export const getDistance = (p1, p2) => Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));