export class PersistenceManager {
    constructor() {
        this.db = null;
        this.ready = this.init();
    }

    init() {
        return Promise.resolve();
    }

    async getActiveProject() {
        const res = await fetch('/api/project/active');
        if (!res.ok) return null;
        return await res.json();
    }

    async listProjects() {
        const res = await fetch('/api/projects');
        if (!res.ok) return [];
        return await res.json();
    }

    async createProject(name) {
        const res = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (!res.ok) throw new Error('Failed to create project');
        return await res.json();
    }

    async deleteProject(id) {
        await fetch('/api/projects/' + encodeURIComponent(id), { method: 'DELETE' });
    }

    async loadProject(id) {
        const res = await fetch(`/api/projects/${id}/load`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed to load project');
        window.location.reload();
    }

    async saveAsset(file) {
        const assetId = file.name;
        await fetch('/api/asset/' + encodeURIComponent(assetId), {
            method: 'POST',
            headers: {
                'Content-Type': file.type,
                'X-Asset-Name': file.name
            },
            body: file
        });
        return assetId;
    }

    async getAsset(assetId) {
        const res = await fetch('/api/asset/' + encodeURIComponent(assetId));
        if (!res.ok) return null;
        return await res.blob();
    }

    async getAllAssets() {
        const res = await fetch('/api/assets', { cache: 'no-store' });
        if (!res.ok) return [];
        const list = await res.json();
        return list.map(item => ({
            id: item.id,
            url: '/api/asset/' + encodeURIComponent(item.id),
            type: item.mime_type.startsWith('video') ? 'video' : 'image',
            file: { name: item.name }
        }));
    }

    async deleteAsset(id) {
        await fetch('/api/asset/' + encodeURIComponent(id), { method: 'DELETE' });
    }

    async saveState(key, data) {
        await fetch('/api/kv/' + key, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    }

    async loadState(key) {
        const res = await fetch('/api/kv/' + key);
        if (!res.ok) return null;
        return await res.json();
    }

    async clearAll() {
        alert("Reset not fully supported in server mode yet.");
    }

    async getUsage() {
        return { usage: "Server", quota: "Disk" };
    }

    async listServerFiles(path = '') {
        try {
            const res = await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`);
            if (!res.ok) return { path: '', items: [] };
            return await res.json();
        } catch (e) {
            console.error("FS List error", e);
            return { path: '', items: [] };
        }
    }

    async getDrives() {
        try {
            const res = await fetch('/api/drives');
            if (!res.ok) return [];
            return await res.json();
        } catch (e) {
            console.error("Get Drives error", e);
            return [];
        }
    }

    async importAssetFromPath(path, overwrite = false) {
        const res = await fetch('/api/asset/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, overwrite })
        });
        if (res.status === 409) return { conflict: true, path };
        if (!res.ok) throw new Error('Import failed');
        return await res.json();
    }
}

export const db = new PersistenceManager();