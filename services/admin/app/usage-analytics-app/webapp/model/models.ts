import JSONModel from "sap/ui/model/json/JSONModel";
import Device from "sap/ui/Device";

export default {
    createDeviceModel(): JSONModel {
        const deviceModel = new JSONModel(Device);
        deviceModel.setDefaultBindingMode("OneWay");
        return deviceModel;
    }
};