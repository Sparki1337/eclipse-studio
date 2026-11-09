//! Типизированный WMI через COM: без интерпретатора, скриптов и временных файлов.
use std::{
    marker::PhantomData,
    mem::ManuallyDrop,
    rc::Rc,
    time::{Duration, Instant},
};
use windows::{
    core::{Interface, BSTR, HSTRING, PCWSTR},
    Win32::System::{
        Com::{
            CoCreateInstance, CoInitializeEx, CoInitializeSecurity, CoSetProxyBlanket,
            CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, EOAC_DYNAMIC_CLOAKING,
            EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_AUTHN_LEVEL_DEFAULT,
            RPC_C_IMP_LEVEL_IMPERSONATE,
        },
        Ole::{
            SafeArrayCreateVector, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetLBound,
            SafeArrayGetUBound, SafeArrayGetVartype, SafeArrayPutElement,
        },
        Variant::{
            VariantClear, VARENUM, VARIANT, VT_ARRAY, VT_BOOL, VT_BSTR, VT_DISPATCH, VT_EMPTY,
            VT_I4, VT_NULL, VT_UI4, VT_UNKNOWN, VT_VARIANT,
        },
        Wmi::{
            IWbemClassObject, IWbemLocator, IWbemServices, WbemLocator,
            WBEM_FLAG_CONNECT_USE_MAX_WAIT, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY,
        },
    },
};
const MAX_ITEMS: usize = 8192;
const WAIT_MS: i32 = 15_000;
fn error(context: &str, e: windows::core::Error) -> String {
    format!("{context}: {e} (0x{:08X})", e.code().0 as u32)
}
struct Apartment {
    owned: bool,
    _thread: PhantomData<Rc<()>>,
}
impl Apartment {
    fn new() -> Result<Self, String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        // Уже существующий STA не принадлежит этому адаптеру и не освобождается им.
        let owned = if hr.0 as u32 == 0x80010106 {
            false
        } else {
            hr.ok().map_err(|e| error("Инициализация COM", e))?;
            true
        };
        let result = Self {
            owned,
            _thread: PhantomData,
        };
        if let Err(e) = unsafe {
            CoInitializeSecurity(
                None,
                -1,
                None,
                None,
                RPC_C_AUTHN_LEVEL_DEFAULT,
                RPC_C_IMP_LEVEL_IMPERSONATE,
                None,
                EOAC_NONE,
                None,
            )
        } {
            if e.code().0 as u32 != 0x80010119 {
                return Err(error("Безопасность COM", e));
            }
        }
        Ok(result)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.owned {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

// VARIANT нельзя поверхностно клонировать: BSTR, SAFEARRAY и интерфейсы имеют владельца.
#[derive(Default)]
struct Value(VARIANT);
impl Drop for Value {
    fn drop(&mut self) {
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}
impl Value {
    fn tag(&self) -> VARENUM {
        unsafe { self.0.Anonymous.Anonymous.vt }
    }
    fn text(value: &str) -> Self {
        let mut result = Self::default();
        unsafe {
            (*result.0.Anonymous.Anonymous).vt = VT_BSTR;
            (*result.0.Anonymous.Anonymous).Anonymous.bstrVal =
                ManuallyDrop::new(BSTR::from(value));
        }
        result
    }
    fn number(value: u32) -> Self {
        let mut result = Self::default();
        unsafe {
            (*result.0.Anonymous.Anonymous).vt = VT_UI4;
            (*result.0.Anonymous.Anonymous).Anonymous.ulVal = value;
        }
        result
    }
    fn string_array(values: &[String]) -> Result<Self, String> {
        if values.len() > MAX_ITEMS {
            return Err("Слишком большой массив WMI".into());
        }
        let mut result = Self::default();
        unsafe {
            let array = SafeArrayCreateVector(VT_BSTR, 0, values.len() as u32);
            if array.is_null() {
                return Err("Не удалось выделить SAFEARRAY".into());
            }
            (*result.0.Anonymous.Anonymous).vt = VARENUM(VT_ARRAY.0 | VT_BSTR.0);
            (*result.0.Anonymous.Anonymous).Anonymous.parray = array;
            for (index, value) in values.iter().enumerate() {
                let text = BSTR::from(value.as_str());
                // Для VT_BSTR SafeArrayPutElement получает сам BSTR, а не адрес BSTR.
                SafeArrayPutElement(array, &(index as i32), text.as_ptr().cast())
                    .map_err(|e| error("Запись SAFEARRAY", e))?;
            }
        }
        Ok(result)
    }
    fn string(&self) -> Result<String, String> {
        if self.tag() != VT_BSTR {
            return Err("WMI: ожидалась строка".into());
        }
        Ok(unsafe { self.0.Anonymous.Anonymous.Anonymous.bstrVal.to_string() })
    }
    fn unsigned(&self) -> Result<u32, String> {
        match self.tag() {
            VT_UI4 => Ok(unsafe { self.0.Anonymous.Anonymous.Anonymous.ulVal }),
            // CIM_UINT32 нередко передаётся WMI как VT_I4 с тем же набором битов.
            VT_I4 => Ok(unsafe { self.0.Anonymous.Anonymous.Anonymous.lVal as u32 }),
            _ => Err("WMI: ожидалось 32-битное число".into()),
        }
    }
    fn boolean(&self) -> Result<bool, String> {
        if self.tag() != VT_BOOL {
            return Err("WMI: ожидалось логическое значение".into());
        }
        Ok(unsafe { self.0.Anonymous.Anonymous.Anonymous.boolVal.0 != 0 })
    }
    fn embedded(&self) -> Result<IWbemClassObject, String> {
        unsafe {
            let unknown = match self.tag() {
                VT_UNKNOWN => self
                    .0
                    .Anonymous
                    .Anonymous
                    .Anonymous
                    .punkVal
                    .as_ref()
                    .cloned(),
                VT_DISPATCH => self
                    .0
                    .Anonymous
                    .Anonymous
                    .Anonymous
                    .pdispVal
                    .as_ref()
                    .map(|v| v.cast::<windows::core::IUnknown>())
                    .transpose()
                    .map_err(|e| error("Объект WMI", e))?,
                _ => return Err("WMI: ожидался встроенный объект".into()),
            }
            .ok_or("WMI вернул пустой объект")?;
            unknown
                .cast()
                .map_err(|e| error("Интерфейс объекта WMI", e))
        }
    }
    fn elements(&self) -> Result<Vec<Self>, String> {
        if matches!(self.tag(), VT_EMPTY | VT_NULL) {
            return Ok(Vec::new());
        }
        if self.tag().0 & VT_ARRAY.0 == 0 || self.tag().0 & !0x2fff != 0 {
            return Err("WMI: ожидался обычный массив, не ссылка".into());
        }
        unsafe {
            let array = self.0.Anonymous.Anonymous.Anonymous.parray;
            if array.is_null() || SafeArrayGetDim(array) != 1 {
                return Err("Неверная размерность SAFEARRAY".into());
            }
            let lower = SafeArrayGetLBound(array, 1).map_err(|e| error("Граница SAFEARRAY", e))?;
            let upper = SafeArrayGetUBound(array, 1).map_err(|e| error("Граница SAFEARRAY", e))?;
            let count = i64::from(upper) - i64::from(lower) + 1;
            if !(0..=MAX_ITEMS as i64).contains(&count) {
                return Err("Слишком большой SAFEARRAY WMI".into());
            }
            let kind = SafeArrayGetVartype(array).map_err(|e| error("Тип SAFEARRAY", e))?;
            if kind.0 != self.tag().0 & 0xfff {
                return Err("Несогласованный тип SAFEARRAY".into());
            }
            let mut result = Vec::with_capacity(count as usize);
            for n in 0..count {
                let index = (i64::from(lower) + n) as i32;
                let mut value = Self::default();
                if kind == VT_VARIANT {
                    SafeArrayGetElement(array, &index, (&mut value.0 as *mut VARIANT).cast())
                        .map_err(|e| error("Чтение SAFEARRAY VARIANT", e))?;
                } else {
                    (*value.0.Anonymous.Anonymous).vt = kind;
                    let fields = &mut (*value.0.Anonymous.Anonymous).Anonymous;
                    let ptr = match kind {
                        VT_BSTR => (&mut fields.bstrVal as *mut ManuallyDrop<BSTR>).cast(),
                        VT_UNKNOWN => (&mut fields.punkVal
                            as *mut ManuallyDrop<Option<windows::core::IUnknown>>)
                            .cast(),
                        VT_DISPATCH => (&mut fields.pdispVal
                            as *mut ManuallyDrop<Option<windows::Win32::System::Com::IDispatch>>)
                            .cast(),
                        VT_I4 => (&mut fields.lVal as *mut i32).cast(),
                        VT_UI4 => (&mut fields.ulVal as *mut u32).cast(),
                        _ => return Err("Неподдерживаемый тип элементов WMI".into()),
                    };
                    SafeArrayGetElement(array, &index, ptr)
                        .map_err(|e| error("Чтение SAFEARRAY", e))?;
                }
                result.push(value);
            }
            Ok(result)
        }
    }
}
pub(super) enum Input<'a> {
    Text(&'a str),
    Number(u32),
    Strings(&'a [String]),
}
impl Input<'_> {
    fn value(&self) -> Result<Value, String> {
        match self {
            Self::Text(value) => Ok(Value::text(value)),
            Self::Number(value) => Ok(Value::number(*value)),
            Self::Strings(value) => Value::string_array(value),
        }
    }
}

// Интерфейс освобождается до CoUninitialize; объекты ниже заимствуют эту связь.
pub(super) struct Connection {
    services: IWbemServices,
    _apartment: Apartment,
}
pub(super) struct Object<'a> {
    raw: IWbemClassObject,
    _connection: PhantomData<&'a Connection>,
}
impl Connection {
    pub(super) fn open(namespace: &str) -> Result<Self, String> {
        let apartment = Apartment::new()?;
        let locator: IWbemLocator =
            unsafe { CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER) }
                .map_err(|e| error("Создание WMI", e))?;
        let empty = BSTR::new();
        let services = unsafe {
            locator.ConnectServer(
                &BSTR::from(namespace),
                &empty,
                &empty,
                &empty,
                WBEM_FLAG_CONNECT_USE_MAX_WAIT.0,
                &empty,
                None,
            )
        }
        .map_err(|e| error("Подключение WMI", e))?;
        unsafe {
            CoSetProxyBlanket(
                &services,
                10,
                0,
                PCWSTR::null(),
                RPC_C_AUTHN_LEVEL_CALL,
                RPC_C_IMP_LEVEL_IMPERSONATE,
                None,
                EOAC_DYNAMIC_CLOAKING,
            )
        }
        .map_err(|e| error("Авторизация WMI", e))?;
        Ok(Self {
            services,
            _apartment: apartment,
        })
    }
    fn wrap(&self, raw: IWbemClassObject) -> Object<'_> {
        Object {
            raw,
            _connection: PhantomData,
        }
    }
    pub(super) fn get(&self, path: &str) -> Result<Object<'_>, String> {
        let mut pending = None;
        unsafe {
            self.services.GetObject(
                &BSTR::from(path),
                WBEM_FLAG_RETURN_IMMEDIATELY,
                None,
                None,
                Some(&mut pending),
            )
        }
        .map_err(|e| error("Запрос объекта WMI", e))?;
        let result = unsafe {
            pending
                .ok_or("WMI не вернул результат запроса")?
                .GetResultObject(WAIT_MS)
        }
        .map_err(|e| error("Ожидание объекта WMI", e))?;
        Ok(self.wrap(result))
    }
    pub(super) fn query(&self, query: &str) -> Result<Vec<Object<'_>>, String> {
        let items = unsafe {
            self.services.ExecQuery(
                &BSTR::from("WQL"),
                &BSTR::from(query),
                WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                None,
            )
        }
        .map_err(|e| error("Запрос WMI", e))?;
        let started = Instant::now();
        let mut result = Vec::new();
        loop {
            if started.elapsed() > Duration::from_millis(WAIT_MS as u64) {
                return Err("Время чтения WMI истекло".into());
            }
            let mut objects = [None];
            let mut count = 0;
            let hr = unsafe { items.Next(1000, &mut objects, &mut count) };
            hr.ok().map_err(|e| error("Перечисление WMI", e))?;
            if count == 0 {
                if hr.0 == 1 {
                    break;
                } else {
                    continue;
                }
            }
            if count != 1 || result.len() >= MAX_ITEMS {
                return Err("Неверное число объектов WMI".into());
            }
            result.push(self.wrap(objects[0].take().ok_or("Пустой объект WMI")?));
        }
        Ok(result)
    }
    pub(super) fn call(
        &self,
        class: &str,
        path: &str,
        method: &str,
        args: &[(&str, Input<'_>)],
    ) -> Result<Object<'_>, String> {
        let definition = self.get(class)?;
        let mut signature = None;
        let mut output_signature = None;
        unsafe {
            definition.raw.GetMethod(
                &HSTRING::from(method),
                0,
                &mut signature,
                &mut output_signature,
            )
        }
        .map_err(|e| error("Описание метода WMI", e))?;
        let input = if let Some(signature) = signature {
            let input =
                unsafe { signature.SpawnInstance(0) }.map_err(|e| error("Параметры WMI", e))?;
            for (name, value) in args {
                let value = value.value()?;
                unsafe { input.Put(&HSTRING::from(*name), 0, &value.0, 0) }
                    .map_err(|e| error("Параметр WMI", e))?;
            }
            Some(input)
        } else {
            if !args.is_empty() {
                return Err("Метод WMI не принимает параметры".into());
            }
            None
        };
        let mut result = None;
        // Запись синхронна: нельзя отпустить системную блокировку и начать откат,
        // пока провайдер ещё способен завершить предыдущую запись в фоне.
        unsafe {
            self.services.ExecMethod(
                &BSTR::from(path),
                &BSTR::from(method),
                Default::default(),
                None,
                input.as_ref(),
                Some(&mut result),
                None,
            )
        }
        .map_err(|e| error("Вызов метода WMI", e))?;
        Ok(self.wrap(result.ok_or("WMI не вернул ответ метода")?))
    }
}
impl<'a> Object<'a> {
    fn property(&self, name: &str) -> Result<Value, String> {
        let mut value = Value::default();
        unsafe {
            self.raw
                .Get(&HSTRING::from(name), 0, &mut value.0, None, None)
        }
        .map_err(|e| error(&format!("Свойство WMI {name}"), e))?;
        Ok(value)
    }
    pub(super) fn text(&self, name: &str) -> Result<String, String> {
        self.property(name)?.string()
    }
    pub(super) fn optional_text(&self, name: &str) -> Result<Option<String>, String> {
        let value = self.property(name)?;
        if matches!(value.tag(), VT_EMPTY | VT_NULL) {
            Ok(None)
        } else {
            value.string().map(Some)
        }
    }
    pub(super) fn number(&self, name: &str) -> Result<u32, String> {
        self.property(name)?.unsigned()
    }
    pub(super) fn boolean(&self, name: &str) -> Result<bool, String> {
        self.property(name)?.boolean()
    }
    pub(super) fn numbers(&self, name: &str) -> Result<Vec<u32>, String> {
        self.property(name)?
            .elements()?
            .iter()
            .map(Value::unsigned)
            .collect()
    }
    pub(super) fn strings(&self, name: &str) -> Result<Vec<String>, String> {
        self.property(name)?
            .elements()?
            .iter()
            .map(Value::string)
            .collect()
    }
    pub(super) fn object(&self, name: &str) -> Result<Self, String> {
        Ok(Self {
            raw: self.property(name)?.embedded()?,
            _connection: PhantomData,
        })
    }
    pub(super) fn objects(&self, name: &str) -> Result<Vec<Self>, String> {
        self.property(name)?
            .elements()?
            .into_iter()
            .map(|value| {
                Ok(Self {
                    raw: value.embedded()?,
                    _connection: PhantomData,
                })
            })
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bstr_and_numbers_round_trip_without_wmi() {
        assert_eq!(
            Value::text("Русский путь \\ игры").string().unwrap(),
            "Русский путь \\ игры"
        );
        assert_eq!(Value::number(u32::MAX).unsigned().unwrap(), u32::MAX);
        assert!(Value::number(1).boolean().is_err());
        assert!(Value::text("1").unsigned().is_err());
    }
    #[test]
    fn safe_array_has_owned_unicode_copies() {
        let data = vec!["{test}".to_string(), "путь\\с пробелом".to_string()];
        let values = Value::string_array(&data).unwrap();
        let unpacked: Vec<_> = values
            .elements()
            .unwrap()
            .iter()
            .map(|v| v.string().unwrap())
            .collect();
        assert_eq!(unpacked, data);
        drop(data);
        assert_eq!(
            values.elements().unwrap()[1].string().unwrap(),
            "путь\\с пробелом"
        );
        assert!(Value::string_array(&vec![String::new(); MAX_ITEMS + 1]).is_err());
    }
    #[test]
    fn null_arrays_are_empty_and_scalar_arrays_are_rejected() {
        assert!(Value::default().elements().unwrap().is_empty());
        assert!(Value::text("not array").elements().is_err());
        assert!(Value::string_array(&[])
            .unwrap()
            .elements()
            .unwrap()
            .is_empty());
    }
}

#[cfg(test)]
mod read_only_integration {
    #[test]
    #[ignore = "Явная проверка чтения реальной WMI, не часть изолированных фикстур"]
    fn native_wmi_read_only() {
        let connection = super::Connection::open(r"root\CIMV2").unwrap();
        let class = connection.get("Win32_OperatingSystem").unwrap();
        assert_eq!(class.text("__CLASS").unwrap(), "Win32_OperatingSystem");
        let objects = connection
            .query("SELECT LastBootUpTime FROM Win32_OperatingSystem")
            .unwrap();
        assert_eq!(objects.len(), 1);
        crate::windows_probe_core::cim_boot_id(&objects[0].text("LastBootUpTime").unwrap())
            .unwrap();
        // Читающий метод своего процесса проверяет ExecMethod без запуска или остановки процессов.
        let processes = connection
            .query(&format!(
                "SELECT __PATH FROM Win32_Process WHERE ProcessId={}",
                std::process::id()
            ))
            .unwrap();
        assert_eq!(processes.len(), 1);
        let owner = connection
            .call(
                "Win32_Process",
                &processes[0].text("__PATH").unwrap(),
                "GetOwner",
                &[],
            )
            .unwrap();
        assert_eq!(owner.number("ReturnValue").unwrap(), 0);
        assert!(!owner.text("User").unwrap().is_empty());
    }
}
