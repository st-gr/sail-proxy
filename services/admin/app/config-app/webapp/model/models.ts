import Device from "sap/ui/Device";
import JSONModel from "sap/ui/model/json/JSONModel";

/**
 * Create device model
 */
export const createDeviceModel = (): JSONModel => {
    const oModel = new JSONModel(Device);
    oModel.setDefaultBindingMode("OneWay");
    return oModel;
};