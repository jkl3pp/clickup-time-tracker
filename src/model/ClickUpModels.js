export const ClickUpType = {
    SPACE: "space",
    FOLDER: "folder",
    LIST: "list",
    TASK: "task",
    SUBTASK: "subtask",
}
export class ClickUpItemFactory {

    constructor() {
        this.colorMap = new Map();
    }

    createItem(item, type) {
        if (item instanceof ClickUpItem){
            return item;
        }
        // Colors
        if (item.color && !this.colorMap[item.color]){
            this.colorMap.set(item.id, item.color)
        } else if (typeof item.space !== 'undefined' && item.space.id && this.colorMap.has(item.space.id)){
            item.color = this.colorMap.get(item.space.id);
        }
        // Create item
        if (typeof item === "object"){
            // This is the only place where clickup items are created
            return new ClickUpItem(item, type);
        }
        throw new Error("Invalid item");
    }

    createSpace(item){
        return this.createItem(item, ClickUpType.SPACE);
    }

    createList(item){
        return this.createItem(item, ClickUpType.LIST);
    }

    createFolder(item){
        return this.createItem(item, ClickUpType.FOLDER)
    }

    createTask(item){
        return this.createItem(item, ClickUpType.TASK);
    }

    createSubtask(item){
        return this.createItem(item, ClickUpType.SUBTASK);
    }

}
export class ClickUpItem{
    // This is the only place where the clickup item is defined
    constructor(item, type){
        if (!Object.values(ClickUpType).includes(type)){
            throw new Error("Invalid type");
        }

        this.id = item.id;
        this.value = item.id;

        this.name = item.name;
        this.label = item.name;

        // Preserve ClickUp custom task ID (e.g., QM-793) when available so we can search by it
        this.custom_id = item.custom_id || null;

        this.type = type;

        switch (this.type){
            case ClickUpType.SPACE:
                this.disable = true;
                break;
            case ClickUpType.FOLDER:
                this.disable = true;
                break;
            case ClickUpType.LIST:
                this.disable = true;
                break;
            case ClickUpType.TASK:
                this.disable = false;
                this.date_closed = item.date_closed != null ? item.date_closed : null;
                break;
            case ClickUpType.SUBTASK:
                this.disable = false;
                this.date_closed = item.date_closed != null ? item.date_closed : null;
                break;
        }

        this.color = item.color;
    }

    addChild(child){
        if (!(child instanceof ClickUpItem)){
            throw new Error("Child must be of type ClickUpItem");
        }
        if (!this.children){
            this.children = [];
        }
        this.children.push(child);
    }

    addChildren(children){
        if (!Array.isArray(children)){
            throw new Error("Children must be an array");
        }
        children.forEach(child => this.addChild(child));
    }
}